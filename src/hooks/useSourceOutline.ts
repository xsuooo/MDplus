import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/prose/state';
import { useCallback, useEffect, useState } from 'react';
import { IMAGE_PREPARATION_MS } from '../config/constants';
import { extractSourceOutline, type Ast } from '../lib/position/editorPosition';
import { measureSourceText } from '../lib/position/sourcePosition';
import type { OutlineItem } from '../lib/types';

import type { Workspace } from './useWorkspace';

/** Outline of the active tab: taken from the editor mirror in rich mode, parsed in a worker in source mode. */
export function useSourceOutline(workspace: Workspace, outlineOpen: boolean) {
  const { activeId, sourceMode, tabRuntime, currentView } = workspace;
  // Worker inputs follow committed state; discarded renders must not consume newer mirror content.
  const sourceMarkdown = workspace.activeTab?.markdown ?? '';
  const [sourceOutline, setSourceOutline] = useState<{
    id: string;
    markdown: string;
    items: OutlineItem[];
    error: boolean;
  } | null>(null);
  const sourceEditor = activeId ? tabRuntime.current[activeId]?.editor : null;
  useEffect(() => {
    if (!outlineOpen || !sourceMode || !activeId || !sourceEditor) return;
    let worker: Worker | undefined;
    const fail = (error: unknown) => {
      worker?.terminate();
      console.warn('源码目录读取失败', error);
      setSourceOutline({ id: activeId, markdown: sourceMarkdown, items: [], error: true });
    };
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL('../lib/sourceOutline.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (event: MessageEvent<Ast>) => {
          worker?.terminate();
          try {
            setSourceOutline({
              id: activeId,
              markdown: sourceMarkdown,
              items: extractSourceOutline(sourceEditor, sourceMarkdown, event.data),
              error: false,
            });
          } catch (error) {
            fail(error);
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          fail(event.message);
        };
        worker.postMessage(sourceMarkdown);
      } catch (error) {
        fail(error);
      }
    }, IMAGE_PREPARATION_MS);
    return () => {
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [outlineOpen, sourceMode, activeId, sourceMarkdown, sourceEditor]);
  const currentSourceOutline =
    sourceOutline?.id === activeId && sourceOutline.markdown === sourceMarkdown
      ? sourceOutline
      : null;
  const outlineItems = sourceMode
    ? (currentSourceOutline?.items ?? [])
    : activeId
      ? (tabRuntime.current[activeId]?.mirror?.outline ?? [])
      : [];
  const outlineStatus =
    sourceMode && outlineOpen && activeId
      ? currentSourceOutline
        ? currentSourceOutline.error
          ? ('error' as const)
          : undefined
        : ('loading' as const)
      : undefined;

  const jumpToOutline = useCallback(
    (pos: number) => {
      const { activeId: id, sourceMode: source } = currentView.current;
      if (source) {
        const input = id ? tabRuntime.current[id]?.sourceInput : null;
        if (!input?.isConnected || pos < 0 || pos > input.value.length) return;
        const top = measureSourceText(input, input.value, (at) => Math.max(0, at(pos) - 24));
        input.focus({ preventScroll: true });
        input.setSelectionRange(pos, pos);
        input.scrollTo({
          top,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth',
        });
        return;
      }
      const editor = id ? tabRuntime.current[id]?.editor : null;
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const target = pos + 1;
        if (target < 0 || target > view.state.doc.content.size) return;
        view.dispatch(
          view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(target))),
        );
        view.focus();
        // Navigate once; normal editing and selection restoration remain instant.
        requestAnimationFrame(() => {
          if (
            currentView.current.activeId !== id ||
            currentView.current.sourceMode ||
            tabRuntime.current[id!]?.editor !== editor
          )
            return;
          const dom = view.nodeDOM(pos);
          const scroller = view.dom.closest<HTMLElement>('.milkdown-container');
          if (dom instanceof HTMLElement && scroller) {
            scroller.scrollTo({
              top:
                scroller.scrollTop +
                dom.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top -
                24,
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 'instant'
                : 'smooth',
            });
          }
        });
      });
    },
    [currentView, tabRuntime],
  );

  return { outlineItems, outlineStatus, jumpToOutline };
}
