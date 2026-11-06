import { useCallback, useState } from 'react';
import { confirmDialog, showMessage } from '../lib/dialog';
import { needsDocumentProtection } from '../lib/documentProtection';
import { rebaseSourcePlace, renderedPlace } from '../lib/editorPosition';
import { errorMessage } from '../lib/errors';
import { basename, documentRevision, pickSaveFile, writeDocument } from '../lib/fileOps';
import {
  commitImageMigration,
  finalizeImageMigration,
  migratePendingImages,
  type ImageMigration,
} from '../lib/imageOps';
import { getImageUrls, isRelativeImageUrl } from '../lib/imagePaths';
import { pathKey } from '../lib/pathIdentity';
import { computeStats } from '../lib/stats';
import { getRecentFiles, pushRecentFile } from '../lib/store';
import type { RecentFile, Tab } from '../lib/types';

import { AUTO_SAVE_DELAY } from '../config/constants';
import type { DocumentSession } from './useDocumentSession';
import type { RecoveryController } from './useRecovery';

type MigrationWriteState = 'unchanged' | 'committed' | 'unknown';

/** A transport rejection cannot prove that native code did not commit. */
async function writePreparedDocument(
  path: string,
  content: string,
  expectedRevision: string | null,
  setState: (state: MigrationWriteState) => void,
) {
  setState('unknown');
  try {
    const receipt = await writeDocument(path, content, expectedRevision);
    setState('committed');
    return receipt;
  } catch (error) {
    if (error && typeof error === 'object' && 'writeState' in error) {
      if (error.writeState === 'unchanged' || error.writeState === 'committed')
        setState(error.writeState);
    }
    throw error;
  }
}

async function finishMigration(migration: ImageMigration | undefined, state: MigrationWriteState) {
  if (!migration) return;
  try {
    await finalizeImageMigration(migration, state);
  } catch (error) {
    console.error('图片保存事务清理失败', error);
    await showMessage(
      `图片资产清理未完成，已保守保留文件，请稍后核对：${errorMessage(error)}`,
      'error',
    );
  }
}

export function useDocumentSave(
  session: DocumentSession,
  recovery: RecoveryController,
  setRecentFiles: (files: RecentFile[]) => void,
) {
  const {
    tabsRef,
    saveGenerations,
    saveTimers,
    saveQueues,
    contentGenerations,
    tabMirror,
    positions,
    sourceRewrites,
    editorRegistry,
    blockedExternalMtime,
    detectedExternalStates,
    activeId,
    activeTab,
    resolveContent,
    updateTab,
    pauseAutoSave,
    syncEditor,
  } = session;
  const { prepareCurrentImages, cleanRecovery, protectDraft } = recovery;
  const [savingId, setSavingId] = useState<string | null>(null);
  /* ---------- 保存 ---------- */
  /**
   * 将图片迁移后的内容同步回编辑器实例、内容镜像与源码视图。
   * 仅在确认「写入期间没有新编辑」后调用;迁移未改变内容时直接返回。
   * 源码模式下同步内容镜像,避免另存为后 textarea 仍显示旧占位,
   * 否则下一次源码编辑会用过期文本覆写镜像、把迁移结果静默回退。
   */
  const applyMigratedContent = useCallback(
    (tabId: string, migratedContent: string, originalContent: string): void => {
      if (migratedContent === originalContent) return;
      syncEditor(tabId, migratedContent, false);
      const saved = positions.current[tabId];
      const references = sourceRewrites.current[tabId] ?? [];
      if (saved?.source) {
        saved.source = rebaseSourcePlace(
          saved.source,
          originalContent,
          migratedContent,
          references,
        );
      }
      if (saved?.exchange?.markdown === originalContent) {
        const exchange = saved.exchange;
        exchange.source = rebaseSourcePlace(
          exchange.source,
          originalContent,
          migratedContent,
          references,
        );
        exchange.markdown = migratedContent;
        const editor = editorRegistry.current[tabId];
        if (editor) exchange.rendered.doc = renderedPlace(editor).doc;
      }
      tabMirror.current[tabId] = {
        ...(tabMirror.current[tabId] ?? {
          markdown: migratedContent,
          outline: [],
          stats: computeStats(migratedContent),
          canUndo: false,
          canRedo: false,
        }),
        markdown: migratedContent,
        stats: computeStats(migratedContent),
      };
    },
    [editorRegistry, positions, sourceRewrites, syncEditor, tabMirror],
  );

  const handleSaveAsFor = useCallback(
    async (tab: Tab, generation: number, saveCurrent: () => Promise<boolean>): Promise<boolean> => {
      const isCurrentSave = () =>
        (saveGenerations.current[tab.id] ?? 0) === generation &&
        tabsRef.current.some((candidate) => candidate.id === tab.id);
      let migration: ImageMigration | undefined;
      let writeState: MigrationWriteState = 'unchanged';
      try {
        if (!isCurrentSave()) return false;
        const selected = await pickSaveFile(tab.path ?? `${tab.title}`);
        if (!selected || !isCurrentSave()) return false;
        const destination = await documentRevision(selected);
        if (!isCurrentSave()) return false;
        const target = destination.path;
        const latestBeforeWrite = tabsRef.current.find((candidate) => candidate.id === tab.id)!;
        // Choosing the current path must keep the normal external-change checks.
        if (latestBeforeWrite.path && pathKey(latestBeforeWrite.path) === pathKey(target)) {
          return saveCurrent();
        }
        const findCollision = () =>
          tabsRef.current.find(
            (candidate) =>
              candidate.id !== tab.id &&
              candidate.path &&
              pathKey(candidate.path) === pathKey(target),
          );
        const collision = findCollision();
        if (collision) {
          await showMessage(
            `「${collision.title}」已经打开,不能将两个标签保存到同一文件。`,
            'error',
          );
          return false;
        }

        if (
          destination.revision !== null &&
          !(await confirmDialog(`「${basename(target)}」已存在。是否用当前文档替换这个磁盘版本？`))
        )
          return false;
        if (!isCurrentSave()) return false;
        const content = resolveContent(latestBeforeWrite);
        const contentGeneration = contentGenerations.current[tab.id] ?? 0;
        const imagesReady = await prepareCurrentImages(tab.id);
        if (!isCurrentSave()) return false;
        if (!imagesReady || (contentGenerations.current[tab.id] ?? 0) !== contentGeneration) {
          await showMessage(
            '图片准备期间文稿已变化，本次另存为已取消。编辑内容仍保留，请重试。',
            'info',
          );
          return false;
        }
        migration = await migratePendingImages(tab.id, target, content);
        const migratedContent = migration.markdown;
        if (!isCurrentSave()) return false;
        const latestDestination = await documentRevision(target);
        if (
          latestDestination.revision !== destination.revision ||
          pathKey(latestDestination.path) !== pathKey(target)
        ) {
          await showMessage(
            '另存为目标在准备期间发生变化，本次保存已取消，编辑内容仍保留。请重新选择保存位置。',
            'error',
          );
          return false;
        }
        if (!isCurrentSave()) return false;
        const openedDuringPreparation = findCollision();
        if (openedDuringPreparation) {
          await showMessage(
            `「${openedDuringPreparation.title}」已经打开,不能将两个标签保存到同一文件。`,
            'error',
          );
          return false;
        }
        const receipt = await writePreparedDocument(
          target,
          migratedContent,
          destination.revision,
          (state) => {
            writeState = state;
          },
        );
        if (!isCurrentSave()) return false;
        const contentChangedDuringWrite =
          (contentGenerations.current[tab.id] ?? 0) !== contentGeneration;
        const latestContent = resolveContent(latestBeforeWrite);
        if (
          contentChangedDuringWrite &&
          latestBeforeWrite.path &&
          getImageUrls(latestContent).some(isRelativeImageUrl)
        ) {
          // The snapshot exists, but adopting its path would rebase a newer draft's relative images.
          saveGenerations.current[tab.id] = (saveGenerations.current[tab.id] ?? 0) + 1;
          clearTimeout(saveTimers.current[tab.id]);
          delete saveTimers.current[tab.id];
          pauseAutoSave(tab.id, -1);
          updateTab(tab.id, { dirty: true });
          protectDraft(tabsRef.current.find((candidate) => candidate.id === tab.id)!);
          await showMessage(
            `副本已写入「${target}」。保存期间又有含相对图片的新编辑，当前标签仍保留原文件位置和新稿，自动保存已暂停。请重新另存为以保存最新内容。`,
            'info',
          );
          return false;
        }
        if (!contentChangedDuringWrite) {
          commitImageMigration(migration);
          sourceRewrites.current[tab.id] = [
            ...(migration.historyReferences ?? []),
            ...(migration.references ?? []),
          ];
          applyMigratedContent(tab.id, migratedContent, content);
        }
        updateTab(tab.id, {
          path: receipt.path,
          title: basename(target),
          isNew: false,
          externalMtime: receipt.mtime,
          diskRevision: receipt.revision,
          externalChanged: false,
          preserveLocal: false,
          markdown: contentChangedDuringWrite ? latestContent : migratedContent,
          savedContent: migratedContent,
          dirty: contentChangedDuringWrite ? latestContent !== migratedContent : false,
        });
        delete blockedExternalMtime.current[tab.id];
        delete detectedExternalStates.current[tab.id];
        if (!contentChangedDuringWrite) {
          await cleanRecovery(tab.id);
          const latest = tabsRef.current.find((item) => item.id === tab.id);
          if (latest && needsDocumentProtection(latest, resolveContent(latest)))
            protectDraft(latest);
        }
        await pushRecentFile(receipt.path, basename(receipt.path), selected);
        setRecentFiles(await getRecentFiles());
        return true;
      } catch (err) {
        if (!isCurrentSave()) return false;
        console.error('另存为失败', err);
        updateTab(tab.id, { dirty: true });
        const latest = tabsRef.current.find((item) => item.id === tab.id);
        if (latest) protectDraft(latest);
        await showMessage(`另存为失败:${errorMessage(err)}`, 'error');
        return false;
      } finally {
        await finishMigration(migration, writeState);
      }
    },
    [
      saveGenerations,
      tabsRef,
      resolveContent,
      contentGenerations,
      prepareCurrentImages,
      updateTab,
      blockedExternalMtime,
      detectedExternalStates,
      setRecentFiles,
      saveTimers,
      pauseAutoSave,
      protectDraft,
      sourceRewrites,
      applyMigratedContent,
      cleanRecovery,
    ],
  );

  const performSave = useCallback(
    async (
      id: string,
      manual = false,
      generation = saveGenerations.current[id] ?? 0,
      saveAs = false,
    ): Promise<boolean> => {
      const isCurrentSave = () =>
        (saveGenerations.current[id] ?? 0) === generation &&
        tabsRef.current.some((tab) => tab.id === id);

      if (!isCurrentSave()) return false;
      const tab = tabsRef.current.find((candidate) => candidate.id === id);
      if (!tab || (!manual && id in blockedExternalMtime.current)) return false;
      if (saveAs || !tab.path) {
        return manual
          ? handleSaveAsFor(tab, generation, () => performSave(id, true, generation))
          : false;
      }

      let migration: ImageMigration | undefined;
      let writeState: MigrationWriteState = 'unchanged';
      try {
        const disk = await documentRevision(tab.path);
        const diskMtime = disk.mtime ?? 0;
        const blockedMtime = blockedExternalMtime.current[id];
        const hasBlockedExternalChange =
          blockedMtime !== undefined && blockedMtime >= 0 && diskMtime === blockedMtime;
        const hasExternalConflict = disk.revision !== tab.diskRevision || hasBlockedExternalChange;
        if (hasExternalConflict) {
          if (!manual) {
            if (blockedExternalMtime.current[id] !== diskMtime) {
              pauseAutoSave(id, diskMtime);
              await showMessage(
                `「${tab.title}」的磁盘版本已变化，自动保存已暂停。请按 Ctrl+S 确认，或另存为保留两份。`,
                'error',
              );
            }
            return false;
          }
          pauseAutoSave(id, diskMtime);
          const overwrite = await confirmDialog(
            disk.revision === null
              ? `「${tab.title}」已不在原位置。是否在原位置重新创建？选择取消保留编辑内容。`
              : `「${tab.title}」已在磁盘上被修改。\n\n选择「确定」用当前编辑内容覆盖这个磁盘版本；选择「取消」保留未保存内容。`,
          );
          if (!overwrite) return false;
        }

        if (!isCurrentSave()) return false;
        const rawContent = resolveContent(tab);
        const contentGeneration = contentGenerations.current[id] ?? 0;
        const imagesReady = await prepareCurrentImages(id);
        if (!isCurrentSave()) return false;
        if (!imagesReady || (contentGenerations.current[id] ?? 0) !== contentGeneration) {
          if (manual)
            await showMessage(
              '图片准备期间文稿已变化，本次保存已取消。编辑内容仍保留，请重试。',
              'info',
            );
          return false;
        }
        migration = await migratePendingImages(id, tab.path, rawContent);
        const content = migration.markdown;
        if (!isCurrentSave()) return false;
        // The native writer also checks these bytes and preserves copies on an uncertain replacement.
        const latestDisk = await documentRevision(tab.path);
        if (latestDisk.revision !== disk.revision) {
          pauseAutoSave(id, latestDisk.mtime ?? 0);
          await showMessage(
            `「${tab.title}」在确认或图片保存期间再次被修改，本次保存已取消。编辑内容仍保留，请重新确认。`,
            'error',
          );
          return false;
        }
        if (!isCurrentSave()) return false;
        const receipt = await writePreparedDocument(tab.path, content, disk.revision, (state) => {
          writeState = state;
        });
        if (!isCurrentSave()) return false;
        const contentChangedDuringWrite =
          (contentGenerations.current[id] ?? 0) !== contentGeneration;
        if (!contentChangedDuringWrite) {
          commitImageMigration(migration);
          sourceRewrites.current[id] = [
            ...(migration.historyReferences ?? []),
            ...(migration.references ?? []),
          ];
          applyMigratedContent(id, content, rawContent);
        }
        const latest = contentChangedDuringWrite
          ? (tabMirror.current[id]?.markdown ?? rawContent)
          : content;
        updateTab(id, {
          dirty: latest !== content,
          markdown: latest,
          externalMtime: receipt.mtime,
          diskRevision: receipt.revision,
          externalChanged: false,
          preserveLocal: false,
          savedContent: content,
        });
        delete blockedExternalMtime.current[id];
        delete detectedExternalStates.current[id];
        if (!contentChangedDuringWrite) {
          await cleanRecovery(id);
          const current = tabsRef.current.find((item) => item.id === id);
          if (current && needsDocumentProtection(current, resolveContent(current)))
            protectDraft(current);
        }
        return true;
      } catch (err) {
        if (!isCurrentSave()) return false;
        console.error('保存失败', err);
        pauseAutoSave(id, -1);
        updateTab(id, { dirty: true });
        const latest = tabsRef.current.find((item) => item.id === id);
        if (latest) protectDraft(latest);
        await showMessage(`保存失败:${errorMessage(err)}`, 'error');
        return false;
      } finally {
        await finishMigration(migration, writeState);
      }
    },
    [
      saveGenerations,
      tabsRef,
      blockedExternalMtime,
      handleSaveAsFor,
      resolveContent,
      contentGenerations,
      prepareCurrentImages,
      tabMirror,
      updateTab,
      detectedExternalStates,
      pauseAutoSave,
      sourceRewrites,
      applyMigratedContent,
      cleanRecovery,
      protectDraft,
    ],
  );

  const doSave = useCallback(
    (id: string, manual = false, saveAs = false): Promise<boolean> => {
      const timer = saveTimers.current[id];
      if (timer) clearTimeout(timer);
      delete saveTimers.current[id];
      const previous = saveQueues.current[id] ?? Promise.resolve(true);
      const generation = saveGenerations.current[id] ?? 0;
      setSavingId(id);
      const next = previous
        .catch(() => false)
        .then(() => performSave(id, manual, generation, saveAs));
      saveQueues.current[id] = next;
      const finish = () => {
        if (saveQueues.current[id] === next) {
          delete saveQueues.current[id];
          setSavingId((current) => (current === id ? null : current));
        }
      };
      void next.then(finish, finish);
      return next;
    },
    [performSave, saveGenerations, saveQueues, saveTimers],
  );

  const scheduleAutoSave = useCallback(
    (id: string) => {
      const timer = saveTimers.current[id];
      if (timer) clearTimeout(timer);
      saveTimers.current[id] = setTimeout(() => void doSave(id), AUTO_SAVE_DELAY);
    },
    [doSave, saveTimers],
  );

  const handleSave = useCallback(async () => {
    if (activeId) await doSave(activeId, true);
  }, [activeId, doSave]);

  const handleSaveAs = useCallback(async () => {
    if (!activeTab) return;
    await doSave(activeTab.id, true, true);
  }, [activeTab, doSave]);

  return { doSave, scheduleAutoSave, handleSave, handleSaveAs, savingId };
}
