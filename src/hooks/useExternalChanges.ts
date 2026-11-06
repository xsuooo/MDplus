import { useCallback, useEffect } from 'react';
import { EXTERNAL_POLL_MS } from '../config/constants';
import { confirmDialog, showMessage } from '../lib/dialog';
import { documentRevision, readDocument } from '../lib/fileOps';
import { prepareImageReferences, type PreparedImageReferences } from '../lib/imageOps';
import { computeStats } from '../lib/stats';
import { needsDocumentProtection } from '../lib/documentProtection';

import type { DocumentSession } from './useDocumentSession';
import type { RecoveryController } from './useRecovery';

export function useExternalChanges(
  session: DocumentSession,
  recovery: Pick<RecoveryController, 'cleanRecovery' | 'protectDraft'>,
) {
  const { cleanRecovery, protectDraft } = recovery;
  const {
    setTabs,
    activeId,
    activeTab,
    tabMirror,
    tabsRef,
    saveTimers,
    saveQueues,
    saveGenerations,
    contentGenerations,
    blockedExternalMtime,
    detectedExternalStates,
    externalChecks,
    externalPrompts,
    currentView,
    syncEditor,
    updateTab,
    pauseAutoSave,
  } = session;
  /* ---------- 外部文件变化检测 ---------- */
  const promptExternalReload = useCallback(
    async (tabId: string, detectedMtime: number, detectedRevision: string | null) => {
      if (externalPrompts.current.has(tabId)) return;
      externalPrompts.current.add(tabId);
      let images: PreparedImageReferences | undefined;
      try {
        const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
        if (!tab?.path || tab.dirty || tabId in saveQueues.current) return;
        const version = contentGenerations.current[tabId] ?? 0;
        const saveGeneration = saveGenerations.current[tabId] ?? 0;
        const isCurrentDocument = () => {
          const latest = tabsRef.current.find((candidate) => candidate.id === tabId);
          return (
            !!latest &&
            latest.path === tab.path &&
            (saveGenerations.current[tabId] ?? 0) === saveGeneration
          );
        };
        const canApply = () =>
          isCurrentDocument() &&
          (contentGenerations.current[tabId] ?? 0) === version &&
          !tabsRef.current.find((candidate) => candidate.id === tabId)?.dirty &&
          !(tabId in saveQueues.current);
        const cancelReload = async () => {
          if (!isCurrentDocument()) return;
          // 不推进已知 mtime:下次检测仍需确认,自动保存也必须保留冲突保护。
          pauseAutoSave(tabId, detectedMtime);
          await showMessage(
            `「${tab.title}」在重新加载期间发生变化,本次重载已取消,已保留本地内容。请按 Ctrl+S 手动处理。`,
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
          images = await prepareImageReferences(tabId, snapshot.content, tab.path, {
            refresh: true,
          });
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
          const previous = tabMirror.current[tabId];
          const nextStats = computeStats(content);
          const timer = saveTimers.current[tabId];
          if (timer) clearTimeout(timer);
          delete saveTimers.current[tabId];
          contentGenerations.current[tabId] = version + 1;
          delete blockedExternalMtime.current[tabId];
          delete detectedExternalStates.current[tabId];
          // 先提交新基线,避免同步编辑器回调把重载当作未保存输入。
          tabMirror.current[tabId] = {
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
            externalMtime: loadedMtime,
            diskRevision: snapshot.revision,
            externalChanged: false,
            preserveLocal: false,
            savedContent: content,
          });
          syncEditor(tabId, content);
          setTabs([...tabsRef.current]);
          await cleanRecovery(tabId);
          const current = tabsRef.current.find((candidate) => candidate.id === tabId);
          if (current && needsDocumentProtection(current)) protectDraft(current);
        } else {
          // 保留本地内容时记录冲突 mtime,避免后续自动保存静默覆盖外部版本。
          pauseAutoSave(tabId, detectedMtime);
          updateTab(tabId, {
            externalMtime: detectedMtime,
            externalChanged: tabId !== currentView.current.activeId,
          });
        }
      } catch (error) {
        const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
        if (blockedExternalMtime.current[tabId] !== -1) {
          pauseAutoSave(tabId, -1);
          if (tab?.id === activeId) {
            await showMessage(
              `无法读取「${tab.title}」的磁盘状态,文件可能已被删除或权限已变化。请按 Ctrl+S 手动处理。`,
              'error',
            );
          } else {
            updateTab(tabId, { externalChanged: true });
          }
        }
        console.warn('检测外部文件变化失败', error);
      } finally {
        externalPrompts.current.delete(tabId);
        try {
          await images?.dispose();
        } catch (error) {
          console.error('释放外部图片准备失败', error);
        }
      }
    },
    [
      externalPrompts,
      tabsRef,
      saveQueues,
      contentGenerations,
      saveGenerations,
      pauseAutoSave,
      tabMirror,
      saveTimers,
      blockedExternalMtime,
      detectedExternalStates,
      updateTab,
      syncEditor,
      setTabs,
      currentView,
      activeId,
      cleanRecovery,
      protectDraft,
    ],
  );

  // 切回后台已变化的标签时再询问,避免后台标签弹窗打断当前编辑。
  useEffect(() => {
    if (!activeTab?.externalChanged || activeTab.dirty) return;
    void promptExternalReload(
      activeTab.id,
      activeTab.externalMtime,
      detectedExternalStates.current[activeTab.id]?.revision ?? activeTab.diskRevision,
    );
  }, [
    activeTab?.dirty,
    activeTab?.diskRevision,
    activeTab?.externalChanged,
    activeTab?.externalMtime,
    activeTab?.id,
    detectedExternalStates,
    promptExternalReload,
  ]);

  useEffect(() => {
    const timer = setInterval(() => {
      const candidates = tabsRef.current.filter(
        (tab) =>
          tab.path &&
          !tab.dirty &&
          !(tab.id in saveQueues.current) &&
          !externalChecks.current.has(tab.id) &&
          !externalPrompts.current.has(tab.id),
      );
      for (const candidate of candidates) {
        externalChecks.current.add(candidate.id);
        void (async () => {
          try {
            // Poll byte revisions off the input path; timestamps can be preserved.
            // A timestamp-only change still allows refreshing relative image bytes.
            const disk = await documentRevision(candidate.path!);
            const latest = tabsRef.current.find((tab) => tab.id === candidate.id);
            if (
              !latest ||
              latest.path !== candidate.path ||
              latest.dirty ||
              latest.diskRevision !== candidate.diskRevision ||
              latest.id in saveQueues.current
            )
              return;
            if (disk.revision === null) throw new Error('文件已不在原位置');
            const mtime = disk.mtime ?? 0;
            if (disk.revision === latest.diskRevision && mtime === latest.externalMtime) return;
            const offered = detectedExternalStates.current[latest.id];
            if (offered?.revision === disk.revision && offered.mtime === mtime) return;
            detectedExternalStates.current[latest.id] = { revision: disk.revision, mtime };
            updateTab(latest.id, { preserveLocal: true });
            if (latest.id === activeId) {
              await promptExternalReload(latest.id, mtime, disk.revision);
            } else {
              updateTab(latest.id, { externalMtime: mtime, externalChanged: true });
            }
          } catch (error) {
            const latest = tabsRef.current.find((tab) => tab.id === candidate.id);
            if (
              latest &&
              latest.path === candidate.path &&
              blockedExternalMtime.current[latest.id] !== -1
            ) {
              pauseAutoSave(latest.id, -1);
              if (latest.id === activeId) {
                await showMessage(
                  `无法读取「${latest.title}」的磁盘状态,文件可能已被删除或权限已变化。请按 Ctrl+S 手动处理。`,
                  'error',
                );
              } else {
                updateTab(latest.id, { externalChanged: true });
              }
            }
            console.warn('检测外部文件变化失败', error);
          } finally {
            externalChecks.current.delete(candidate.id);
          }
        })();
      }
    }, EXTERNAL_POLL_MS);
    return () => clearInterval(timer);
  }, [
    activeId,
    promptExternalReload,
    updateTab,
    pauseAutoSave,
    tabsRef,
    saveQueues,
    externalChecks,
    externalPrompts,
    detectedExternalStates,
    blockedExternalMtime,
  ]);
}
