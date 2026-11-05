import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useRef, useState } from 'react';
import { makeId } from '../hooks/useDocumentSession';
import { showMessage } from '../lib/dialog';
import { errorMessage } from '../lib/errors';
import { basename, documentRevision, pickOpenFile, readDocument } from '../lib/fileOps';
import { clearPendingImages, prepareImageReferences } from '../lib/imageOps';
import { pathKey } from '../lib/pathIdentity';
import { getRecentFiles, pushRecentFile, removeRecentFile } from '../lib/store';
import { getTemplate } from '../lib/templates';
import type { RecentFile } from '../lib/types';

import type { DocumentSession } from './useDocumentSession';

export function useDocumentFiles(session: DocumentSession) {
  const { tabsRef, openingPaths, selectTab, addTab } = session;
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [fileDialogBusy, setFileDialogBusy] = useState(false);
  const [startupResolved, setStartupResolved] = useState(() => !isTauri());
  const startupInitStarted = useRef(false);
  /* ---------- 最近打开初始化 ---------- */
  useEffect(() => {
    void getRecentFiles().then(setRecentFiles);
  }, []);

  /* ---------- 打开 / 新建 ---------- */
  const openFileFromPath = useCallback(
    async (path: string) => {
      const key = pathKey(path);
      const alreadyOpen = tabsRef.current.find((t) => t.path && pathKey(t.path) === key);
      if (alreadyOpen) {
        selectTab(alreadyOpen.id);
        return;
      }
      if (openingPaths.current.has(key)) return;
      openingPaths.current.add(key);
      const ownedKeys = [key];
      try {
        const { path: canonicalPath, content, mtime, revision } = await readDocument(path);
        const canonicalKey = pathKey(canonicalPath);
        if (canonicalKey !== key) {
          if (openingPaths.current.has(canonicalKey)) return;
          openingPaths.current.add(canonicalKey);
          ownedKeys.push(canonicalKey);
        }
        const existing = tabsRef.current.find((t) => t.path && pathKey(t.path) === canonicalKey);
        if (existing) {
          selectTab(existing.id);
        } else {
          const id = makeId();
          try {
            const images = await prepareImageReferences(id, content, canonicalPath, {
              refresh: true,
            });
            const currentDisk = await documentRevision(canonicalPath);
            if (
              currentDisk.revision !== revision ||
              pathKey(currentDisk.path) !== canonicalKey ||
              !images.commit()
            ) {
              throw new Error('文档在图片读取期间已变化，请重新打开；未改写任何文件');
            }
            // Save As can adopt this path while the open's image reads are pending.
            const opened = tabsRef.current.find((t) => t.path && pathKey(t.path) === canonicalKey);
            if (opened) {
              clearPendingImages(id);
              selectTab(opened.id);
            } else
              addTab(
                {
                  title: basename(canonicalPath),
                  path: canonicalPath,
                  isNew: false,
                  content,
                  mtime,
                  revision,
                },
                id,
              );
          } catch (error) {
            clearPendingImages(id);
            throw error;
          }
        }
        // 最近文件持久化不应阻塞文档标签创建或启动窗口显示。
        void pushRecentFile(canonicalPath, basename(canonicalPath), path).then(async () => {
          setRecentFiles(await getRecentFiles());
        });
      } catch (err) {
        console.error('打开文件失败', err);
        await removeRecentFile(path);
        setRecentFiles(await getRecentFiles());
        await showMessage(
          `无法打开文件:${errorMessage(err)}\n\n如果该文件来自最近列表,已将失效记录移除。`,
          'error',
        );
      } finally {
        for (const ownedKey of ownedKeys) openingPaths.current.delete(ownedKey);
      }
    },
    [addTab, openingPaths, selectTab, tabsRef],
  );

  const handleOpen = useCallback(async () => {
    if (fileDialogBusy) return; // 防止重复打开
    setFileDialogBusy(true);
    try {
      const path = await pickOpenFile();
      if (path) await openFileFromPath(path);
    } catch (err) {
      console.error('文件选择器打开失败', err);
      await showMessage(`无法打开文件选择器:${errorMessage(err)}`, 'error');
    } finally {
      setFileDialogBusy(false);
    }
  }, [openFileFromPath, fileDialogBusy]);

  /* ---------- 启动时打开命令行传递的文件 ---------- */
  useEffect(() => {
    if (!isTauri() || startupInitStarted.current) return;
    startupInitStarted.current = true;

    void invoke<string[]>('take_startup_files')
      .then((startupFiles) => {
        if (!Array.isArray(startupFiles) || startupFiles.length === 0) {
          setStartupResolved(true);
          return;
        }

        // 确保窗口可见
        const win = getCurrentWindow();
        void win.show().catch((error) => console.warn('显示窗口失败', error));
        void win.setFocus().catch((error) => console.warn('聚焦窗口失败', error));

        // 打开所有通过命令行传递的文件
        const openPromises = startupFiles.map((filePath) => openFileFromPath(filePath));
        void Promise.all(openPromises).then(() => setStartupResolved(true));
      })
      .catch((err) => {
        console.error('读取启动文件失败', err);
        // 命令调用失败时仍结束启动占位,避免应用保持空白。
        setStartupResolved(true);
      });
  }, [openFileFromPath]);

  /* ---------- 监听单实例传递的文件 ---------- */
  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;
    let disposed = false;
    let drainQueue = Promise.resolve();
    const drainPendingFiles = async () => {
      const openFiles = await invoke<string[]>('take_pending_open_files');
      if (Array.isArray(openFiles) && openFiles.length > 0) {
        // 窗口置顶并获得焦点
        const win = getCurrentWindow();
        void win.show().catch((error) => console.warn('显示窗口失败', error));
        void win.setFocus().catch((error) => console.warn('聚焦窗口失败', error));
        void win.unminimize().catch((error) => console.warn('还原窗口失败', error));

        // 打开新传递的文件
        for (const filePath of openFiles) {
          void openFileFromPath(filePath);
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
  }, [openFileFromPath]);

  const handleRemoveRecent = useCallback(async (path: string) => {
    await removeRecentFile(path);
    setRecentFiles(await getRecentFiles());
  }, []);

  const createDocument = useCallback(
    (kind: 'blank' | 'basic') => {
      const content = getTemplate(kind);
      const count = tabsRef.current.filter((t) => t.isNew).length;
      const title = count === 0 ? '未命名文档.md' : `未命名文档 ${count + 1}.md`;
      addTab({ title, path: null, isNew: true, content, mtime: 0 });
    },
    [addTab, tabsRef],
  );

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
            const ignored = event.payload.paths.length - md.length;
            void (async () => {
              for (const path of md) await openFileFromPath(path);
              if (ignored)
                await showMessage(
                  `已忽略 ${ignored} 个非 Markdown 路径。仅支持 .md 和 .markdown 文件。`,
                  'info',
                );
            })();
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
  }, [openFileFromPath]);

  return {
    recentFiles,
    setRecentFiles,
    fileDialogBusy,
    startupResolved,
    openFileFromPath,
    handleOpen,
    handleRemoveRecent,
    createDocument,
  };
}
