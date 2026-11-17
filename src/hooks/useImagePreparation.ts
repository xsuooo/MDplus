import { useCallback } from 'react';
import { prepareImageReferences } from '../lib/imageOps';
import { scheduleImagePreparation } from '../lib/imagePreparation';
import type { Workspace } from './useWorkspace';

/** Resolves the images the current text refers to before save, export or a recovery snapshot reads them. */
export function useImagePreparation(workspace: Workspace) {
  const { tabsRef, tabRuntime, runtimeOf, resolveContent } = workspace;
  // Input coalesces staged reads; save/export flush the exact current source.
  const prepareCurrentImages = useCallback(
    (id: string, defer = false): Promise<boolean> => {
      const tab = tabsRef.current.find((candidate) => candidate.id === id);
      if (!tab) return Promise.resolve(false);
      const path = tab.path,
        revision = tab.diskRevision;
      const version = tabRuntime.current[id]?.contentVersion ?? 0;
      const content = resolveContent(tab);
      const pending = tabRuntime.current[id]?.imagePreparation;
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
        try {
          const current = tabsRef.current.find((candidate) => candidate.id === id);
          return (
            !!current &&
            current.path === path &&
            current.diskRevision === revision &&
            (tabRuntime.current[id]?.contentVersion ?? 0) === version &&
            resolveContent(current) === content &&
            (prepared?.commit() ?? true)
          );
        } finally {
          await prepared?.dispose();
        }
      });
      const promise = work.promise.finally(() => {
        if (tabRuntime.current[id]?.imagePreparation?.promise === promise)
          delete tabRuntime.current[id]?.imagePreparation;
      });
      runtimeOf(id).imagePreparation = { ...work, version, content, path, revision, promise };
      if (!defer) void work.flush();
      return promise;
    },
    [tabRuntime, runtimeOf, resolveContent, tabsRef],
  );
  return prepareCurrentImages;
}
