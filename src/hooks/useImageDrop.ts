import { useCallback, useRef, useState } from 'react';
import { editorViewCtx } from '@milkdown/kit/core';
import { insertImageBatchAt, trackEditorPosition } from '../lib/editor';
import {
  containsDropPosition,
  physicalToClientPosition,
  runImageDrop,
  sourceOffsetAtPoint,
  trackSourcePosition,
  type CapturedImageDrop,
  type DropPosition,
  type ImageDropReason,
  type ImageDropResult,
  type ImageDropProgress,
} from '../lib/imageDrop';
import type { SourceEditorApi } from '../lib/sourceEditorApi';
import { pickImageFiles } from '../lib/fileOps';
import type { DocumentSession } from './useDocumentSession';

export type { ImageDropResult } from '../lib/imageDrop';

/** Reuse useDocumentFiles' one native drag listener; capture happens before the
 * first await, so mixed Markdown/image drops cannot redirect the target. */
export function useImageDrop(
  session: DocumentSession,
  getSourceApi: (tabId: string) => SourceEditorApi | null,
) {
  const dependencies = useRef({ session, getSourceApi });
  dependencies.current = { session, getSourceApi };
  const pickingRef = useRef(false);
  const [picking, setPicking] = useState(false);
  const batchesRef = useRef(new Map<CapturedImageDrop, ImageDropProgress>());
  const [progress, setProgress] = useState<ImageDropProgress | null>(null);
  const insert = useCallback(async (paths: readonly string[], target: CapturedImageDrop) => {
    const report = (next?: ImageDropProgress) => {
      if (next) batchesRef.current.set(target, next);
      else batchesRef.current.delete(target);
      const batches = [...batchesRef.current.values()];
      setProgress(
        batches.length
          ? batches.reduce(
              (sum, batch) => ({
                completed: sum.completed + batch.completed,
                total: sum.total + batch.total,
              }),
              { completed: 0, total: 0 },
            )
          : null,
      );
    };
    try {
      return await runImageDrop(paths, target, undefined, report);
    } finally {
      report();
    }
  }, []);

  const captureTarget = useCallback(
    (physicalPosition?: DropPosition): CapturedImageDrop | ImageDropReason => {
      const { session, getSourceApi } = dependencies.current;
      const { activeId: tabId, sourceMode } = session.currentView.current;
      if (!tabId || !session.tabsRef.current.some((tab) => tab.id === tabId)) return 'no-document';
      const point = physicalPosition ? physicalToClientPosition(physicalPosition) : null;
      if (physicalPosition && !point) return 'outside-editor';
      const modeGeneration = session.modeGenerations.current[tabId] ?? 0;

      const sameMode = () => {
        const current = session.currentView.current;
        return (
          (current.activeId === tabId
            ? current.sourceMode
            : (session.positions.current[tabId]?.sourceMode ?? sourceMode)) === sourceMode
        );
      };
      const foreground = () => session.currentView.current.activeId === tabId && sameMode();
      const lifetimeReason = (): ImageDropReason | undefined => {
        if (!session.tabsRef.current.some((tab) => tab.id === tabId)) return 'target-closed';
        if (!sameMode() || (session.modeGenerations.current[tabId] ?? 0) !== modeGeneration)
          return 'target-changed';
      };
      let target: CapturedImageDrop;
      if (sourceMode) {
        const input = session.sourceRegistry.current[tabId];
        const api = getSourceApi(tabId);
        if (!input || !api) return 'editor-unavailable';
        const offset = point ? sourceOffsetAtPoint(input, point) : api.read().end;
        if (offset === null) return 'outside-editor';
        const position = trackSourcePosition(api, offset);
        target = {
          tabId,
          invalidReason: () =>
            lifetimeReason() ??
            (session.sourceRegistry.current[tabId] !== input ||
            getSourceApi(tabId) !== api ||
            !input.isConnected
              ? 'editor-unavailable'
              : undefined),
          release: position.release,
          insert: (placeholders) => {
            const at = position.read();
            if (at === null) return false;
            const markup = placeholders.map((placeholder) => `![](${placeholder})`).join('\n');
            return api.applyEdits(
              [{ from: at, to: at, text: markup }],
              foreground() ? { start: at + markup.length, end: at + markup.length } : undefined,
            );
          },
        };
      } else {
        const editor = session.editorRegistry.current[tabId];
        if (!editor) return 'editor-unavailable';
        try {
          const view = editor.action((ctx) => ctx.get(editorViewCtx));
          const scroller = view.dom.closest<HTMLElement>('.milkdown-container') ?? view.dom;
          if (point && !containsDropPosition(scroller, point)) return 'outside-editor';
          const rect = view.dom.getBoundingClientRect();
          const hit = point
            ? view.posAtCoords({
                left: Math.min(Math.max(point.x, rect.left + 1), rect.right - 1),
                top: Math.min(Math.max(point.y, rect.top + 1), rect.bottom - 1),
              })
            : { pos: view.state.selection.to };
          if (!hit) return 'outside-editor';
          const position = trackEditorPosition(editor, hit.pos);
          if (!position) return 'editor-unavailable';
          target = {
            tabId,
            invalidReason: () =>
              lifetimeReason() ??
              (session.editorRegistry.current[tabId] !== editor || position.read() === null
                ? 'editor-unavailable'
                : undefined),
            release: position.release,
            insert: (placeholders) => {
              const at = position.read();
              return (
                at !== null &&
                insertImageBatchAt(
                  editor,
                  at,
                  placeholders.map((src) => ({ src })),
                  foreground(),
                )
              );
            },
          };
        } catch (error) {
          console.warn('拖入图片落点不可用', error);
          return 'editor-unavailable';
        }
      }
      return target;
    },
    [],
  );
  const handle = useCallback(
    (paths: readonly string[], point: DropPosition): Promise<ImageDropResult> => {
      const target = captureTarget(point);
      return typeof target === 'string'
        ? Promise.resolve({ attempted: paths.length, inserted: 0, failures: [], reason: target })
        : insert(paths, target);
    },
    [captureTarget, insert],
  );
  const pick = useCallback(async (): Promise<ImageDropResult | null> => {
    if (pickingRef.current) return null;
    // Freeze the original tab and selection before the native dialog yields.
    const target = captureTarget();
    if (typeof target === 'string')
      return { attempted: 0, inserted: 0, failures: [], reason: target };
    pickingRef.current = true;
    setPicking(true);
    try {
      const paths = await pickImageFiles();
      if (!paths.length) {
        target.release();
        return null;
      }
      return await insert(paths, target);
    } catch (error) {
      target.release();
      throw error;
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  }, [captureTarget, insert]);
  return { handle, pick, picking, progress };
}
