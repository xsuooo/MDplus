import { useCallback, useEffect, useRef } from 'react';
import { EXTERNAL_POLL_MS } from '../config/constants';
import { confirmDialog, showMessage } from '../lib/dialog';
import { documentRevision, readDocument } from '../lib/fileOps';
import { prepareImageReferences, type PreparedImageReferences } from '../lib/imageOps';
import { computeStats } from '../lib/stats';
import { needsDocumentProtection } from '../lib/documentProtection';
import type { Tab } from '../lib/types';

import type { Workspace } from './useWorkspace';
import type { RecoveryController } from './useRecovery';

const BACKGROUND_EXTERNAL_POLL_MS = EXTERNAL_POLL_MS * 15;

export function useExternalChanges(
  workspace: Workspace,
  recovery: Pick<RecoveryController, 'deleteRecoverySnapshot' | 'saveRecoverySnapshot'>,
) {
  const { deleteRecoverySnapshot, saveRecoverySnapshot } = recovery;
  const {
    setTabs,
    activeId,
    activeTab,
    tabRuntime,
    runtimeOf,
    tabsRef,
    tabEpoch,
    diskOf,
    resumeAutoSave,
    currentView,
    syncEditor,
    updateTab,
    pauseAutoSave,
  } = workspace;
  const externalLastChecks = useRef<Record<string, number>>({});
  const previousActiveId = useRef(activeId);
  /* ---------- 外部文件变化检测 ---------- */
  const reportUnreadable = useCallback(
    async (tab: Tab) => {
      if (tabRuntime.current[tab.id]?.disk?.pausedMtime === null) return;
      pauseAutoSave(tab.id, null);
      if (tab.id === activeId) {
        await showMessage(
          `无法读取「${tab.title}」的磁盘状态,文件可能已被删除或权限已变化。请点击工具栏「保存」手动处理。`,
          'error',
        );
      } else {
        updateTab(tab.id, { externalChanged: true });
      }
    },
    [activeId, tabRuntime, pauseAutoSave, updateTab],
  );

  const promptExternalReload = useCallback(
    async (tabId: string, detectedMtime: number, detectedRevision: string | null) => {
      if (tabRuntime.current[tabId]?.disk?.prompting) return;
      diskOf(tabId).prompting = true;
      let images: PreparedImageReferences | undefined;
      try {
        const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
        if (!tab?.path || tab.dirty || tabRuntime.current[tabId]?.saveQueue !== undefined) return;
        const version = tabRuntime.current[tabId]?.contentVersion ?? 0;
        const saveGeneration = tabEpoch(tabId);
        const isCurrentDocument = () => {
          const latest = tabsRef.current.find((candidate) => candidate.id === tabId);
          return !!latest && latest.path === tab.path && tabEpoch(tabId) === saveGeneration;
        };
        const canApply = () =>
          isCurrentDocument() &&
          (tabRuntime.current[tabId]?.contentVersion ?? 0) === version &&
          !tabsRef.current.find((candidate) => candidate.id === tabId)?.dirty &&
          !(tabRuntime.current[tabId]?.saveQueue !== undefined);
        const cancelReload = async () => {
          if (!isCurrentDocument()) return;
          // 不推进已知 mtime:下次检测仍需确认,自动保存也必须保留冲突保护。
          pauseAutoSave(tabId, detectedMtime);
          await showMessage(
            `「${tab.title}」在重新加载期间发生变化,本次重载已取消,已保留本地内容。请点击工具栏「保存」手动处理。`,
            'info',
          );
        };

        const reload = await confirmDialog(
          `「${tab.title}」已在磁盘上被修改。\n\n选择「确定」重新加载文件;选择「取消」保留本地内容。`,
        );
        if (!canApply()) {
          await cancelReload();
          return;
        }
        if (reload) {
          const snapshot = await readDocument(tab.path);
          if (!canApply()) {
            await cancelReload();
            return;
          }
          try {
            images = await prepareImageReferences(tabId, snapshot.content, tab.path, {
              refresh: true,
            });
          } catch (error) {
            // The document was just read, so this is not a missing file: keep the local
            // version exactly as if the reload had been declined.
            console.warn('准备磁盘版本的图片失败', error);
            pauseAutoSave(tabId, detectedMtime);
            const active = tabId === currentView.current.activeId;
            updateTab(tabId, { diskMtime: detectedMtime, externalChanged: !active });
            if (active)
              await showMessage(
                `无法载入「${tab.title}」磁盘版本中的图片,本次未重新加载,已保留本地内容。磁盘上的文件没有被改动。`,
                'error',
              );
            return;
          }
          if (!canApply()) {
            await cancelReload();
            return;
          }
          const currentDisk = await documentRevision(tab.path);
          const content = snapshot.content;
          const loadedMtime = snapshot.mtime;
          // Never pair a previously read body with a newer file's revision.
          if (
            !canApply() ||
            currentDisk.revision !== snapshot.revision ||
            snapshot.revision !== detectedRevision ||
            !images.commit()
          ) {
            await cancelReload();
            return;
          }
          const previous = tabRuntime.current[tabId]?.mirror;
          const nextStats = computeStats(content);
          const timer = tabRuntime.current[tabId]?.saveTimer;
          if (timer) clearTimeout(timer);
          delete tabRuntime.current[tabId]?.saveTimer;
          runtimeOf(tabId).contentVersion = version + 1;
          resumeAutoSave(tabId);
          // 先提交新基线,避免同步编辑器回调把重载当作未保存输入。
          runtimeOf(tabId).mirror = {
            markdown: content,
            outline: previous?.outline ?? [],
            stats: nextStats,
            canUndo: previous?.canUndo ?? false,
            canRedo: previous?.canRedo ?? false,
          };
          updateTab(tabId, {
            markdown: content,
            stats: nextStats,
            dirty: false,
            diskMtime: loadedMtime,
            diskRevision: snapshot.revision,
            externalChanged: false,
            preserveLocal: false,
            savedContent: content,
          });
          syncEditor(tabId, content);
          setTabs([...tabsRef.current]);
          await deleteRecoverySnapshot(tabId);
          const current = tabsRef.current.find((candidate) => candidate.id === tabId);
          if (current && needsDocumentProtection(current)) saveRecoverySnapshot(current);
        } else {
          // 保留本地内容时记录冲突 mtime,避免后续自动保存静默覆盖外部版本。
          pauseAutoSave(tabId, detectedMtime);
          updateTab(tabId, {
            diskMtime: detectedMtime,
            externalChanged: tabId !== currentView.current.activeId,
          });
        }
      } catch (error) {
        const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
        if (tab) await reportUnreadable(tab);
        console.warn('检测外部文件变化失败', error);
      } finally {
        {
          const sync = tabRuntime.current[tabId]?.disk;
          if (sync) sync.prompting = false;
        }
        try {
          await images?.dispose();
        } catch (error) {
          console.error('释放外部图片准备失败', error);
        }
      }
    },
    [
      tabsRef,
      tabRuntime,
      runtimeOf,
      tabEpoch,
      pauseAutoSave,
      reportUnreadable,
      diskOf,
      resumeAutoSave,
      updateTab,
      syncEditor,
      setTabs,
      currentView,
      deleteRecoverySnapshot,
      saveRecoverySnapshot,
    ],
  );

  // 切回后台已变化的标签时再询问,避免后台标签弹窗打断当前编辑。
  useEffect(() => {
    if (!activeTab?.externalChanged || activeTab.dirty) return;
    void promptExternalReload(
      activeTab.id,
      activeTab.diskMtime,
      tabRuntime.current[activeTab.id]?.disk?.detected?.revision ?? activeTab.diskRevision,
    );
  }, [
    tabRuntime,
    runtimeOf,
    activeTab?.dirty,
    activeTab?.diskRevision,
    activeTab?.externalChanged,
    activeTab?.diskMtime,
    activeTab?.id,
    promptExternalReload,
  ]);

  const checkExternal = useCallback(
    (candidate: Tab) => {
      const path = candidate.path;
      if (
        !path ||
        candidate.dirty ||
        tabRuntime.current[candidate.id]?.saveQueue !== undefined ||
        tabRuntime.current[candidate.id]?.disk?.checking ||
        tabRuntime.current[candidate.id]?.disk?.prompting
      )
        return;
      externalLastChecks.current[candidate.id] = Date.now();
      diskOf(candidate.id).checking = true;
      void (async () => {
        try {
          // Keep full byte revisions: timestamps and file sizes can be preserved.
          const disk = await documentRevision(path);
          const latest = tabsRef.current.find((tab) => tab.id === candidate.id);
          if (
            !latest ||
            latest.path !== candidate.path ||
            latest.dirty ||
            latest.diskRevision !== candidate.diskRevision ||
            tabRuntime.current[latest.id]?.saveQueue !== undefined
          )
            return;
          if (disk.revision === null) throw new Error('文件已不在原位置');
          const mtime = disk.mtime ?? 0;
          if (disk.revision === latest.diskRevision && mtime === latest.diskMtime) return;
          const offered = tabRuntime.current[latest.id]?.disk?.detected;
          if (offered?.revision === disk.revision && offered.mtime === mtime) return;
          diskOf(latest.id).detected = { revision: disk.revision, mtime };
          updateTab(latest.id, { preserveLocal: true });
          if (latest.id === activeId) {
            await promptExternalReload(latest.id, mtime, disk.revision);
          } else {
            updateTab(latest.id, { diskMtime: mtime, externalChanged: true });
          }
        } catch (error) {
          const latest = tabsRef.current.find((tab) => tab.id === candidate.id);
          if (latest && latest.path === candidate.path) await reportUnreadable(latest);
          console.warn('检测外部文件变化失败', error);
        } finally {
          {
            const sync = tabRuntime.current[candidate.id]?.disk;
            if (sync) sync.checking = false;
          }
        }
      })();
    },
    [activeId, diskOf, tabRuntime, reportUnreadable, promptExternalReload, tabsRef, updateTab],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const candidate of tabsRef.current) {
        if (
          candidate.id !== activeId &&
          now - (externalLastChecks.current[candidate.id] ?? 0) < BACKGROUND_EXTERNAL_POLL_MS
        )
          continue;
        checkExternal(candidate);
      }
    }, EXTERNAL_POLL_MS);
    return () => clearInterval(timer);
  }, [activeId, checkExternal, tabsRef]);

  useEffect(() => {
    if (previousActiveId.current === activeId) return;
    previousActiveId.current = activeId;
    const candidate = tabsRef.current.find((tab) => tab.id === activeId);
    if (candidate) checkExternal(candidate);
  }, [activeId, checkExternal, tabsRef]);
}
