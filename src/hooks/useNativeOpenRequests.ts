import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useEffect, useRef } from 'react';
import { showMessage } from '../lib/dialog';
import { isDroppedImagePath } from '../lib/imageDrop';

/**
 * Files that arrive from outside the UI: a second app instance handing over its paths, and
 * files dropped on the window (documents are opened, images go to onImageDrop).
 */
export function useNativeOpenRequests(
  openDocumentPath: (path: string, options?: { silent?: boolean }) => Promise<unknown>,
  // Single-instance paths wait for startup restore so they open after the restored tabs.
  startupWork: { current: Promise<void> | null },
  onImageDrop?: (paths: string[], position: { x: number; y: number }) => Promise<void>,
) {
  const imageDrop = useRef(onImageDrop);
  imageDrop.current = onImageDrop;

  /* ---------- 监听单实例传递的文件 ---------- */
  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;
    let disposed = false;
    let drainQueue = Promise.resolve();
    const drainPendingFiles = async () => {
      if (startupWork.current) await startupWork.current;
      const openFiles = await invoke<string[]>('take_pending_open_files');
      if (Array.isArray(openFiles) && openFiles.length > 0) {
        // 打开新传递的文件
        for (const filePath of openFiles) {
          await openDocumentPath(filePath, { silent: true });
        }
      }
    };
    const enqueueDrain = () => {
      drainQueue = drainQueue
        .then(drainPendingFiles)
        .catch((err) => console.error('读取单实例文件队列失败', err));
    };

    void listen('open-files', enqueueDrain)
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        // 监听注册前到达的事件会留在后端队列,注册完成后主动补取一次。
        enqueueDrain();
      })
      .catch((err) => {
        console.error('注册单实例文件监听失败', err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openDocumentPath, startupWork]);

  /* ---------- 拖拽打开 ---------- */
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === 'over') {
            document.body.classList.add('dragging');
          } else if (event.payload.type === 'drop') {
            document.body.classList.remove('dragging');
            const md = event.payload.paths.filter((p) => /\.(md|markdown)$/i.test(p));
            const images = event.payload.paths.filter(isDroppedImagePath);
            const ignored =
              event.payload.paths.length - md.length - (imageDrop.current ? images.length : 0);
            const position = { x: event.payload.position.x, y: event.payload.position.y };
            void (async () => {
              if (images.length && imageDrop.current) await imageDrop.current(images, position);
              for (const path of md) await openDocumentPath(path);
              if (ignored)
                await showMessage(
                  imageDrop.current
                    ? `已忽略 ${ignored} 个不支持的路径。支持 .md、.markdown、.png、.jpg 和 .jpeg 文件。`
                    : `已忽略 ${ignored} 个非 Markdown 路径。仅支持 .md 和 .markdown 文件。`,
                  'info',
                );
            })().catch((error) => console.warn('拖放处理失败', error));
          } else if (event.payload.type === 'leave') {
            document.body.classList.remove('dragging');
          }
        });
        if (disposed) {
          unlisten();
          unlisten = undefined;
        }
      } catch (err) {
        console.warn('拖拽监听不可用', err);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
      document.body.classList.remove('dragging');
    };
  }, [openDocumentPath]);
}
