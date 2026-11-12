import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useCallback, useEffect, useRef, useState } from 'react';
import { makeId } from '../hooks/useDocumentSession';
import { showMessage } from '../lib/dialog';
import { errorMessage } from '../lib/errors';
import { basename, documentRevision, pickOpenFile, readDocument } from '../lib/fileOps';
import {
  clearPendingImages,
  prepareImageReferences,
  type PreparedImageReferences,
} from '../lib/imageOps';
import { pathKey } from '../lib/pathIdentity';
import type { SessionDocument } from '../lib/documentSession';
import { getRecentFiles, pushRecentFile, removeRecentFile } from '../lib/store';
import { getTemplate } from '../lib/templates';
import type { RecentFile, Tab } from '../lib/types';
import { waitForWindowReady } from '../services/windowState';

import type { DocumentSession } from './useDocumentSession';
import { useSessionPersistence } from './useSessionPersistence';

export interface DocumentFileOptions {
  onImageDrop?: (paths: string[], position: { x: number; y: number }) => Promise<void>;
}
interface OpenOptions {
  silent?: boolean;
  activate?: boolean;
  restore?: SessionDocument;
}

export function useDocumentFiles(session: DocumentSession, options: DocumentFileOptions = {}) {
  const { tabsRef, openingPaths, selectTab, addTab, installSessionPlace, setTabs } = session;
  const persistence = useSessionPersistence(session);
  const {
    readStoredSession,
    completeSessionStartup,
    recordSessionFailure,
    resolveSessionFailure,
    adoptSessionPath,
    retrySessionPersistence,
    getFailedSessionDocuments,
    getSavedSession,
  } = persistence;
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [recentFilesReady, setRecentFilesReady] = useState(false);
  const [fileDialogBusy, setFileDialogBusy] = useState(false);
  const [startupResolved, setStartupResolved] = useState(() => !isTauri());
  const startupInitStarted = useRef(false);
  const startupWork = useRef<Promise<void> | null>(null);
  const pendingOpens = useRef(new Map<string, Promise<Tab | undefined>>());
  const alive = useRef(true);
  const [sessionRestoreBusy, setSessionRestoreBusy] = useState(() => isTauri());
  const retrying = useRef<Promise<void> | null>(null);
  const imageDrop = useRef(options.onImageDrop);
  imageDrop.current = options.onImageDrop;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /* ---------- 最近打开初始化 ---------- */
  useEffect(() => {
    let disposed = false;
    void getRecentFiles()
      .then((files) => {
        if (!disposed) setRecentFiles(files);
      })
      .catch((error) => {
        console.warn('最近文件读取不可用', error);
        void waitForWindowReady().then(() => {
          if (!disposed)
            void showMessage(
              `无法读取最近列表：${errorMessage(error)}。文稿文件未受影响。`,
              'error',
            );
        });
      })
      .finally(() => {
        if (!disposed) setRecentFilesReady(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  /* ---------- 打开 / 新建 ---------- */
  const openDocumentPath = useCallback(
    async (path: string, openOptions: OpenOptions = {}): Promise<Tab | undefined> => {
      const key = pathKey(path);
      const alreadyOpen = tabsRef.current.find((t) => t.path && pathKey(t.path) === key);
      if (alreadyOpen) {
        if (openOptions.restore?.place)
          installSessionPlace(alreadyOpen.id, openOptions.restore.place);
        if (openOptions.activate !== false) selectTab(alreadyOpen.id);
        resolveSessionFailure(path, alreadyOpen.path!);
        return alreadyOpen;
      }
      const pending = pendingOpens.current.get(key);
      if (pending) {
        const opened = await pending;
        if (opened && openOptions.restore?.place)
          installSessionPlace(opened.id, openOptions.restore.place);
        if (opened && openOptions.activate !== false) selectTab(opened.id);
        return opened;
      }
      if (openingPaths.current.has(key)) return;
      openingPaths.current.add(key);
      const ownedKeys = [key];
      const operation = (async () => {
        try {
          const { path: canonicalPath, content, mtime, revision } = await readDocument(path);
          if (!alive.current) return;
          const canonicalKey = pathKey(canonicalPath);
          if (canonicalKey !== key) {
            if (openingPaths.current.has(canonicalKey)) {
              const canonicalPending = pendingOpens.current.get(canonicalKey);
              if (!canonicalPending) return;
              const opened = await canonicalPending;
              if (opened && openOptions.restore?.place)
                installSessionPlace(opened.id, openOptions.restore.place);
              if (opened && openOptions.activate !== false) selectTab(opened.id);
              return opened;
            }
            openingPaths.current.add(canonicalKey);
            ownedKeys.push(canonicalKey);
            const ownedOperation = pendingOpens.current.get(key);
            if (ownedOperation) pendingOpens.current.set(canonicalKey, ownedOperation);
          }
          const existing = tabsRef.current.find((t) => t.path && pathKey(t.path) === canonicalKey);
          let result: Tab | undefined;
          if (existing) {
            if (openOptions.restore?.place)
              installSessionPlace(existing.id, openOptions.restore.place);
            if (openOptions.activate !== false) selectTab(existing.id);
            result = existing;
          } else {
            const id = makeId();
            let images: PreparedImageReferences | undefined;
            try {
              images = await prepareImageReferences(id, content, canonicalPath, {
                refresh: true,
              });
              const currentDisk = await documentRevision(canonicalPath);
              if (!alive.current) return;
              if (
                currentDisk.revision !== revision ||
                pathKey(currentDisk.path) !== canonicalKey ||
                !images.commit()
              ) {
                throw new Error('文档在图片读取期间已变化，请重新打开；未改写任何文件');
              }
              // Save As can adopt this path while the open's image reads are pending.
              const opened = tabsRef.current.find(
                (t) => t.path && pathKey(t.path) === canonicalKey,
              );
              if (opened) {
                clearPendingImages(id);
                if (openOptions.restore?.place)
                  installSessionPlace(opened.id, openOptions.restore.place);
                if (openOptions.activate !== false) selectTab(opened.id);
                result = opened;
              } else {
                addTab(
                  {
                    title: basename(canonicalPath),
                    path: canonicalPath,
                    isNew: false,
                    content,
                    mtime,
                    revision,
                    activate: openOptions.activate,
                    place: openOptions.restore?.place,
                  },
                  id,
                );
                result = tabsRef.current.find((tab) => tab.id === id);
              }
            } catch (error) {
              clearPendingImages(id);
              throw error;
            } finally {
              await images?.dispose();
            }
          }
          // 最近文件持久化不应阻塞文档标签创建或启动窗口显示。
          void pushRecentFile(canonicalPath, basename(canonicalPath), path)
            .then(async () => {
              const files = await getRecentFiles();
              if (alive.current) setRecentFiles(files);
            })
            .catch(async (error) => {
              console.warn('最近文件写入不可用', error);
              await waitForWindowReady();
              if (alive.current)
                await showMessage(
                  `文稿已打开，但最近列表更新失败：${errorMessage(error)}。`,
                  'error',
                );
            });
          if (result) adoptSessionPath(path, result);
          return result;
        } catch (err) {
          console.error('打开文件失败', err);
          let recentRemoved = false;
          try {
            await removeRecentFile(path);
            const recent = await getRecentFiles();
            if (alive.current) setRecentFiles(recent);
            recentRemoved = true;
          } catch (recentError) {
            console.warn('最近文件清理暂不可用', recentError);
          }
          if (!alive.current) return;
          if (openOptions.silent) {
            recordSessionFailure(openOptions.restore ?? { path, title: basename(path) }, err);
            return;
          }
          await waitForWindowReady();
          await showMessage(
            `无法打开文件:${errorMessage(err)}\n\n${recentRemoved ? '如果该文件来自最近列表，已将失效记录移除。' : '最近列表更新失败，失效记录可能仍会显示。'}`,
            'error',
          );
        } finally {
          for (const ownedKey of ownedKeys) openingPaths.current.delete(ownedKey);
        }
      })();
      pendingOpens.current.set(key, operation);
      const finish = () => {
        for (const ownedKey of ownedKeys)
          if (pendingOpens.current.get(ownedKey) === operation)
            pendingOpens.current.delete(ownedKey);
      };
      void operation.then(finish, finish);
      return operation;
    },
    [
      addTab,
      adoptSessionPath,
      installSessionPlace,
      openingPaths,
      recordSessionFailure,
      resolveSessionFailure,
      selectTab,
      tabsRef,
    ],
  );
  const openFileFromPath = useCallback(
    async (path: string) => {
      return openDocumentPath(path);
    },
    [openDocumentPath],
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

  const reorderSessionTabs = useCallback(() => {
    const documents = getSavedSession().documents;
    const ordinal = new Map(documents.map((entry, index) => [pathKey(entry.path), index]));
    const ordered = tabsRef.current
      .map((tab, index) => ({ tab, index }))
      .sort((first, second) => {
        const a = first.tab.path ? ordinal.get(pathKey(first.tab.path)) : undefined;
        const b = second.tab.path ? ordinal.get(pathKey(second.tab.path)) : undefined;
        return (a ?? Infinity) - (b ?? Infinity) || first.index - second.index;
      })
      .map((entry) => entry.tab);
    tabsRef.current = ordered;
    setTabs([...ordered]);
  }, [getSavedSession, setTabs, tabsRef]);

  /* ---------- 启动时恢复已保存文稿,并优先显示这次请求的文件 ---------- */
  useEffect(() => {
    if (!isTauri() || startupInitStarted.current) return;
    startupInitStarted.current = true;

    // The command-line file remains independent of a slow settings read. Once
    // metadata arrives, restored tabs are reordered and same-path tabs reused.
    let requestedActive: string | null = null;
    const requested = invoke<string[]>('take_startup_files')
      .then(async (paths) => {
        if (!Array.isArray(paths)) return;
        for (const path of paths) {
          if (typeof path !== 'string' || !alive.current) continue;
          const opened = await openDocumentPath(path, { silent: true });
          if (opened) requestedActive = opened.id;
        }
        if (requestedActive && alive.current) setStartupResolved(true);
      })
      .catch((error) => console.error('读取启动文件失败', error));
    startupWork.current = (async () => {
      try {
        const loaded = await readStoredSession();
        if (!alive.current) return;
        if (loaded.enabled) {
          for (const entry of [...loaded.session.documents]) {
            if (!alive.current) return;
            await openDocumentPath(entry.path, { silent: true, activate: false, restore: entry });
          }
          reorderSessionTabs();
        }
        await requested;
        if (!alive.current) return;
        const restoredActive =
          loaded.enabled && loaded.session.activePath
            ? tabsRef.current.find(
                (tab) => tab.path && pathKey(tab.path) === pathKey(loaded.session.activePath!),
              )?.id
            : null;
        const requestedStillOpen =
          requestedActive && tabsRef.current.some((tab) => tab.id === requestedActive)
            ? requestedActive
            : null;
        selectTab(
          requestedStillOpen ??
            restoredActive ??
            session.currentView.current.activeId ??
            tabsRef.current[0]?.id ??
            null,
        );
      } catch (error) {
        console.warn('会话恢复暂不可用', error);
        await requested;
      } finally {
        if (alive.current) {
          completeSessionStartup();
          setSessionRestoreBusy(false);
          // Error reporting is aggregated and never awaits the hidden window's reveal.
          setStartupResolved(true);
        }
      }
    })();
  }, [
    completeSessionStartup,
    openDocumentPath,
    readStoredSession,
    reorderSessionTabs,
    selectTab,
    session.currentView,
    tabsRef,
  ]);

  const retrySessionFailures = useCallback((): Promise<void> => {
    if (retrying.current) return retrying.current;
    const operation = (async () => {
      if (startupWork.current) await startupWork.current;
      if (!alive.current) return;
      setSessionRestoreBusy(true);
      const active = session.currentView.current.activeId;
      try {
        const loaded = await retrySessionPersistence();
        const candidates = [
          ...(loaded?.enabled ? loaded.session.documents : []),
          ...getFailedSessionDocuments(),
        ];
        const entries = [
          ...new Map(candidates.map((entry) => [pathKey(entry.path), entry])).values(),
        ];
        for (const entry of [...entries]) {
          if (!alive.current) return;
          await openDocumentPath(entry.path, { silent: true, activate: false, restore: entry });
        }
        reorderSessionTabs();
        const latestActive = session.currentView.current.activeId;
        if (latestActive && tabsRef.current.some((tab) => tab.id === latestActive))
          selectTab(latestActive);
        else if (active && tabsRef.current.some((tab) => tab.id === active)) selectTab(active);
        else selectTab(tabsRef.current[0]?.id ?? null);
        completeSessionStartup();
      } catch (error) {
        console.warn('重试会话恢复失败', error);
      } finally {
        if (alive.current) setSessionRestoreBusy(false);
      }
    })();
    retrying.current = operation;
    const finish = () => {
      if (retrying.current === operation) retrying.current = null;
    };
    void operation.then(finish, finish);
    return operation;
  }, [
    completeSessionStartup,
    getFailedSessionDocuments,
    openDocumentPath,
    reorderSessionTabs,
    retrySessionPersistence,
    selectTab,
    session.currentView,
    tabsRef,
  ]);

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
  }, [openDocumentPath]);

  const handleRemoveRecent = useCallback(async (path: string) => {
    try {
      await removeRecentFile(path);
      if (alive.current) setRecentFiles(await getRecentFiles());
    } catch (error) {
      if (alive.current)
        await showMessage(
          `最近列表更新失败，记录未确认移除：${errorMessage(error)}。请重试。`,
          'error',
        );
    }
  }, []);

  const createDocument = useCallback(
    (kind: 'blank' | 'basic') => {
      const content = getTemplate(kind);
      const occupiedTitles = new Set(tabsRef.current.map((tab) => tab.title.toLowerCase()));
      let number = 1;
      let title = '未命名文档.md';
      while (occupiedTitles.has(title.toLowerCase())) title = `未命名文档 ${++number}.md`;
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
            const images = event.payload.paths.filter((path) => /\.(png|jpe?g)$/i.test(path));
            const ignored =
              event.payload.paths.length - md.length - (imageDrop.current ? images.length : 0);
            const position = { x: event.payload.position.x, y: event.payload.position.y };
            void (async () => {
              if (images.length && imageDrop.current) await imageDrop.current(images, position);
              for (const path of md) await openFileFromPath(path);
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
  }, [openFileFromPath]);

  return {
    recentFiles,
    recentFilesReady,
    setRecentFiles,
    fileDialogBusy,
    startupResolved,
    openFileFromPath,
    handleOpen,
    handleRemoveRecent,
    createDocument,
    sessionRestoreEnabled: persistence.sessionRestoreEnabled,
    changeSessionRestore: persistence.changeSessionRestore,
    sessionFailures: persistence.sessionFailures,
    sessionController: persistence.sessionController,
    retrySessionFailures,
    sessionRestoreBusy,
  };
}
