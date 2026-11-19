import { invoke, isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { makeId } from '../hooks/useWorkspace';
import { showMessage } from '../lib/dialog';
import { errorMessage } from '../lib/errors';
import { basename, documentRevision, pickOpenFile, readDocument } from '../lib/fileOps';
import {
  clearPendingImages,
  prepareImageReferences,
  type PreparedImageReferences,
} from '../lib/imageOps';
import { pathKey } from '../lib/paths';
import type { SessionDocument } from '../lib/documentSession';
import { pushRecentFile, removeRecentFile } from '../lib/store';
import { getTemplate } from '../lib/templates';
import type { Tab } from '../lib/types';
import { waitForWindowReady } from '../services/windowPersistence';

import { useNativeOpenRequests } from './useNativeOpenRequests';
import { useRecentFiles } from './useRecentFiles';
import type { Workspace } from './useWorkspace';
import { useSessionPersistence } from './useSessionPersistence';

export interface DocumentFileOptions {
  onImageDrop?: (paths: string[], position: { x: number; y: number }) => Promise<void>;
}
interface OpenOptions {
  silent?: boolean;
  activate?: boolean;
  restore?: SessionDocument;
}

/** Opening documents: the open pipeline, the file picker, new documents and startup session restore. */
export function useDocumentFiles(workspace: Workspace, options: DocumentFileOptions = {}) {
  // Paths whose open is in flight, so a second request for the same file is dropped.
  const openingPaths = useRef(new Set<string>());
  const { tabsRef, selectTab, addTab, installSessionPlace, setTabs } = workspace;
  const persistence = useSessionPersistence(workspace);
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
  const { recentFiles, recentFilesReady, setRecentFiles, refreshRecentFiles, handleRemoveRecent } =
    useRecentFiles();
  const [fileDialogBusy, setFileDialogBusy] = useState(false);
  const [startupResolved, setStartupResolved] = useState(() => !isTauri());
  const startupInitStarted = useRef(false);
  const startupWork = useRef<Promise<void> | null>(null);
  const pendingOpens = useRef(new Map<string, Promise<Tab | undefined>>());
  const alive = useRef(true);
  const [sessionRestoreBusy, setSessionRestoreBusy] = useState(() => isTauri());
  const retrying = useRef<Promise<void> | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /* ---------- 打开 / 新建 ---------- */
  const openDocumentPath = useCallback(
    async (path: string, openOptions: OpenOptions = {}): Promise<Tab | undefined> => {
      const key = pathKey(path);
      const reveal = (tab: Tab | undefined) => {
        if (!tab) return;
        if (openOptions.restore?.place) installSessionPlace(tab.id, openOptions.restore.place);
        if (openOptions.activate !== false) selectTab(tab.id);
      };
      const alreadyOpen = tabsRef.current.find((t) => t.path && pathKey(t.path) === key);
      if (alreadyOpen) {
        reveal(alreadyOpen);
        resolveSessionFailure(path, alreadyOpen.path!);
        return alreadyOpen;
      }
      const pending = pendingOpens.current.get(key);
      if (pending) {
        const opened = await pending;
        reveal(opened);
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
              reveal(opened);
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
            reveal(existing);
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
                reveal(opened);
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
            .then(refreshRecentFiles)
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
          // Only a file confirmed absent loses its recent entry; a locked or
          // unreachable one may open fine next time.
          let recentNote = '最近列表中的记录已保留。';
          let missing = false;
          try {
            missing = (await documentRevision(path)).revision === null;
          } catch (probeError) {
            console.warn('无法确认文件是否仍存在', probeError);
          }
          if (missing) {
            try {
              await removeRecentFile(path);
              await refreshRecentFiles();
              recentNote = '如果该文件来自最近列表，已将失效记录移除。';
            } catch (recentError) {
              console.warn('最近文件清理暂不可用', recentError);
              recentNote = '最近列表更新失败，失效记录可能仍会显示。';
            }
          }
          if (!alive.current) return;
          if (openOptions.silent) {
            recordSessionFailure(openOptions.restore ?? { path, title: basename(path) }, err);
            return;
          }
          await waitForWindowReady();
          await showMessage(`无法打开文件:${errorMessage(err)}\n\n${recentNote}`, 'error');
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
      recordSessionFailure,
      refreshRecentFiles,
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
            workspace.currentView.current.activeId ??
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
    workspace.currentView,
    tabsRef,
  ]);

  const retrySessionFailures = useCallback((): Promise<void> => {
    if (retrying.current) return retrying.current;
    const operation = (async () => {
      if (startupWork.current) await startupWork.current;
      if (!alive.current) return;
      setSessionRestoreBusy(true);
      const active = workspace.currentView.current.activeId;
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
        const latestActive = workspace.currentView.current.activeId;
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
    workspace.currentView,
    tabsRef,
  ]);

  const createDocument = useCallback(
    (kind: 'blank' | 'basic') => {
      const content = getTemplate(kind);
      const occupiedTitles = new Set(tabsRef.current.map((tab) => tab.title.toLowerCase()));
      let number = 1;
      const name = kind === 'basic' ? 'Markdown 示例' : '未命名文档';
      let title = `${name}.md`;
      while (occupiedTitles.has(title.toLowerCase())) title = `${name} ${++number}.md`;
      addTab({ title, path: null, isNew: true, content, mtime: 0 });
    },
    [addTab, tabsRef],
  );

  useNativeOpenRequests(openDocumentPath, startupWork, options.onImageDrop);

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
