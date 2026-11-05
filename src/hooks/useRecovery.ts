import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { showMessage } from '../lib/dialog';
import { basename } from '../lib/fileOps';
import { prepareImageReferences } from '../lib/imageOps';
import { scheduleImagePreparation } from '../lib/imagePreparation';
import {
  clearRecovery,
  listRecovery,
  restoreRecovery,
  scheduleRecovery,
  type RecoveryEntry,
  type RecoveryStatus,
} from '../lib/recovery';
import type { Tab } from '../lib/types';

import type { DocumentSession } from './useDocumentSession';

export function useRecovery(session: DocumentSession) {
  const { tabsRef, contentGenerations, imagePreparations, resolveContent, addTab } = session;
  const [recoveryEntries, setRecoveryEntries] = useState<RecoveryEntry[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryStates, setRecoveryStates] = useState<Record<string, RecoveryStatus>>({});
  // Input coalesces staged reads; save/export flush the exact current source.
  const prepareCurrentImages = useCallback(
    (id: string, defer = false): Promise<boolean> => {
      const tab = tabsRef.current.find((candidate) => candidate.id === id);
      if (!tab) return Promise.resolve(false);
      const path = tab.path,
        revision = tab.diskRevision;
      const version = contentGenerations.current[id] ?? 0;
      const content = resolveContent(tab);
      const pending = imagePreparations.current[id];
      if (
        pending?.version === version &&
        pending.content === content &&
        pending.path === path &&
        pending.revision === revision
      ) {
        if (!defer) void pending.flush();
        return pending.promise;
      }
      pending?.cancel();
      const work = scheduleImagePreparation(async () => {
        const prepared = path ? await prepareImageReferences(id, content, path) : null;
        const current = tabsRef.current.find((candidate) => candidate.id === id);
        return (
          !!current &&
          current.path === path &&
          current.diskRevision === revision &&
          (contentGenerations.current[id] ?? 0) === version &&
          resolveContent(current) === content &&
          (prepared?.commit() ?? true)
        );
      });
      const promise = work.promise.finally(() => {
        if (imagePreparations.current[id]?.promise === promise)
          delete imagePreparations.current[id];
      });
      imagePreparations.current[id] = { ...work, version, content, path, revision, promise };
      if (!defer) void work.flush();
      return promise;
    },
    [contentGenerations, imagePreparations, resolveContent, tabsRef],
  );

  const recoveryInitialized = useRef(false);
  const protectDraft = useCallback(
    (tab: Tab) => {
      const current = tabsRef.current.find((candidate) => candidate.id === tab.id);
      if (!current) return;
      scheduleRecovery(
        { ...current, markdown: resolveContent(current) },
        (status) => {
          if (tabsRef.current.some((candidate) => candidate.id === current.id)) {
            setRecoveryStates((previous) => ({ ...previous, [current.id]: status }));
          }
        },
        prepareCurrentImages(current.id, true),
      );
    },
    [prepareCurrentImages, resolveContent, tabsRef],
  );
  const cleanRecovery = useCallback(
    async (id: string) => {
      const generation = contentGenerations.current[id];
      try {
        await clearRecovery(id);
        if (contentGenerations.current[id] === generation) {
          setRecoveryStates((previous) => ({ ...previous, [id]: 'idle' }));
        }
        return true;
      } catch {
        setRecoveryStates((previous) => ({ ...previous, [id]: 'error' }));
        return false;
      }
    },
    [contentGenerations],
  );

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
    async (id: string) => {
      if (tabsRef.current.some((tab) => tab.id === id)) return;
      const snapshot = await restoreRecovery(id);
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
    },
    [addTab, tabsRef],
  );

  const handleRecoveryRemoved = useCallback((id: string) => {
    setRecoveryEntries((entries) => entries.filter((entry) => entry.id !== id));
  }, []);
  return {
    prepareCurrentImages,
    protectDraft,
    cleanRecovery,
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
