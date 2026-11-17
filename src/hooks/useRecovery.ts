import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { showMessage } from '../lib/dialog';
import { basename } from '../lib/fileOps';
import {
  deleteSnapshot,
  listRecovery,
  prepareRecovery,
  scheduleSnapshot,
  type RecoveryEntry,
  type RecoveryStatus,
} from '../lib/recovery';
import type { Tab } from '../lib/types';

import { useImagePreparation } from './useImagePreparation';
import type { Workspace } from './useWorkspace';

export function useRecovery(workspace: Workspace) {
  const { tabs, tabsRef, tabRuntime, saveGenerations, resolveContent, addTab } = workspace;
  const alive = useRef(true);
  const restoring = useRef(new Map<string, Promise<void>>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [recoveryEntries, setRecoveryEntries] = useState<RecoveryEntry[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryStates, setRecoveryStates] = useState<Record<string, RecoveryStatus>>({});
  const prepareCurrentImages = useImagePreparation(workspace);

  const recoveryInitialized = useRef(false);
  const saveRecoverySnapshot = useCallback(
    (tab: Tab) => {
      const current = tabsRef.current.find((candidate) => candidate.id === tab.id);
      if (!current) return;
      scheduleSnapshot(
        { ...current, markdown: resolveContent(current) },
        (status) => {
          if (tabsRef.current.some((candidate) => candidate.id === current.id)) {
            setRecoveryStates((previous) =>
              previous[current.id] === status ? previous : { ...previous, [current.id]: status },
            );
          }
        },
        prepareCurrentImages(current.id, true),
      );
    },
    [prepareCurrentImages, resolveContent, tabsRef],
  );
  const deleteRecoverySnapshot = useCallback(
    async (id: string) => {
      const generation = tabRuntime.current[id]?.contentVersion;
      try {
        await deleteSnapshot(id);
        if (tabRuntime.current[id]?.contentVersion === generation) {
          setRecoveryStates((previous) => ({ ...previous, [id]: 'idle' }));
        }
        return true;
      } catch {
        setRecoveryStates((previous) => ({ ...previous, [id]: 'error' }));
        return false;
      }
    },
    [tabRuntime],
  );

  // Preserve disk-diverged buffers even when no new keystroke made them dirty.
  // Schedule once per transition; unrelated tab renders must not starve debounce.
  const retainedLocalIds = useRef(new Set<string>());
  useEffect(() => {
    const retained = new Set<string>();
    for (const tab of tabs) {
      if (!tab.preserveLocal) continue;
      retained.add(tab.id);
      if (!retainedLocalIds.current.has(tab.id)) saveRecoverySnapshot(tab);
    }
    retainedLocalIds.current = retained;
  }, [tabs, saveRecoverySnapshot]);

  const refreshRecovery = useCallback(async () => {
    try {
      setRecoveryEntries(await listRecovery(tabsRef.current.map((tab) => tab.id)));
    } catch {
      await showMessage(
        '无法读取恢复副本，请检查应用数据目录的可用空间和权限。未删除任何文档。',
        'error',
      );
    }
  }, [tabsRef]);

  useEffect(() => {
    if (!isTauri() || recoveryInitialized.current) return;
    recoveryInitialized.current = true;
    void listRecovery()
      .then((entries) => {
        setRecoveryEntries(entries);
        if (entries.length) setRecoveryOpen(true);
      })
      .catch(() => {
        void showMessage('无法读取恢复副本，请检查应用数据目录的可用空间和权限。', 'error');
      });
  }, []);

  const handleRestore = useCallback(
    (id: string): Promise<void> => {
      const pending = restoring.current.get(id);
      if (pending) return pending;
      if (tabsRef.current.some((tab) => tab.id === id)) return Promise.resolve();
      const lifetime = saveGenerations.current[id] ?? 0;
      const operation = (async () => {
        const prepared = await prepareRecovery(id);
        try {
          if (
            !alive.current ||
            (saveGenerations.current[id] ?? 0) !== lifetime ||
            tabsRef.current.some((tab) => tab.id === id)
          )
            return;
          // Cache installation and tab publication share this synchronous commit.
          // No await may separate them: a stale read must not reset a live cache.
          if (!prepared.commit()) return;
          const snapshot = prepared.snapshot;
          addTab(
            {
              title: `${basename(snapshot.title).replace(/\.md$/i, '')} (恢复).md`,
              path: null,
              isNew: true,
              content: snapshot.markdown,
              recovered: true,
            },
            id,
          );
          setRecoveryEntries((entries) => entries.filter((entry) => entry.id !== id));
          setRecoveryOpen(false);
          setRecoveryStates((previous) => ({ ...previous, [id]: 'protected' }));
        } finally {
          await prepared.dispose();
        }
      })();
      restoring.current.set(id, operation);
      const finish = () => {
        if (restoring.current.get(id) === operation) restoring.current.delete(id);
      };
      void operation.then(finish, finish);
      return operation;
    },
    [addTab, saveGenerations, tabsRef],
  );

  const handleRecoveryRemoved = useCallback((id: string) => {
    setRecoveryEntries((entries) => entries.filter((entry) => entry.id !== id));
  }, []);
  return {
    prepareCurrentImages,
    saveRecoverySnapshot,
    deleteRecoverySnapshot,
    refreshRecovery,
    handleRestore,
    recoveryEntries,
    recoveryOpen,
    setRecoveryOpen,
    recoveryStates,
    handleRecoveryRemoved,
  };
}
export type RecoveryController = ReturnType<typeof useRecovery>;
