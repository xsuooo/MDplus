import { useCallback } from 'react';
import { prepareImageReferences } from '../lib/imageOps';
import { scheduleImagePreparation } from '../lib/imagePreparation';
import type { Workspace } from './useWorkspace';

/** Resolves the images the current text refers to before save, export or a recovery snapshot reads them. */
export function useImagePreparation(workspace: Workspace) {
  const { tabsRef, contentVersions, imagePreparations, resolveContent } = workspace;
  // Input coalesces staged reads; save/export flush the exact current source.
  const prepareCurrentImages = useCallback(
    (id: string, defer = false): Promise<boolean> => {
      const tab = tabsRef.current.find((candidate) => candidate.id === id);
      if (!tab) return Promise.resolve(false);
      const path = tab.path,
        revision = tab.diskRevision;
      const version = contentVersions.current[id] ?? 0;
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
        try {
          const current = tabsRef.current.find((candidate) => candidate.id === id);
          return (
            !!current &&
            current.path === path &&
            current.diskRevision === revision &&
            (contentVersions.current[id] ?? 0) === version &&
            resolveContent(current) === content &&
            (prepared?.commit() ?? true)
          );
        } finally {
          await prepared?.dispose();
        }
      });
      const promise = work.promise.finally(() => {
        if (imagePreparations.current[id]?.promise === promise)
          delete imagePreparations.current[id];
      });
      imagePreparations.current[id] = { ...work, version, content, path, revision, promise };
      if (!defer) void work.flush();
      return promise;
    },
    [contentVersions, imagePreparations, resolveContent, tabsRef],
  );
  return prepareCurrentImages;
}
