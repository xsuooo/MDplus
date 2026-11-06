import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { EditorView } from '@milkdown/prose/view';
import type { Node as PMNode } from '@milkdown/prose/model';
import type { Ctx } from '@milkdown/kit/ctx';
import { editorViewCtx } from '@milkdown/kit/core';
import { LIMITS } from '../config/constants';

export interface Match {
  from: number;
  to: number;
}

/** Exact count/navigation without retaining a Match object for every occurrence. */
export interface TextSearchIndex {
  readonly count: number;
  readonly checkpointCount: number;
  at: (index: number) => Match | undefined;
  slice: (from: number, to: number) => Match[];
}

const HIGHLIGHT_LIMIT = Math.max(1, Math.floor(LIMITS.searchHighlightMatches));
const CHECKPOINT_STRIDE = Math.max(1, Math.floor(LIMITS.searchCheckpointMatches));
const emptyIndex: TextSearchIndex = {
  count: 0,
  checkpointCount: 0,
  at: () => undefined,
  slice: () => [],
};

/** Literal Unicode-aware search keeps offsets in the original UTF-16 string. */
export function createTextSearch(
  text: string,
  keyword: string,
  caseSensitive: boolean,
): TextSearchIndex {
  if (!keyword) return emptyIndex;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = caseSensitive ? 'gu' : 'giu';
  const pattern = new RegExp(escaped, flags);
  const checkpoints: number[] = [];
  let count = 0;
  let match: RegExpExecArray | null;
  // Do not spread matchAll: its per-match arrays otherwise stay live together.
  while ((match = pattern.exec(text)) !== null) {
    if (count % CHECKPOINT_STRIDE === 0) checkpoints.push(match.index);
    count += 1;
  }
  if (!count) return emptyIndex;

  const slice = (from: number, to: number): Match[] => {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
    const start = Math.max(0, Math.trunc(from));
    const end = Math.min(count, Math.trunc(to));
    if (start >= end) return [];
    const checkpoint = Math.floor(start / CHECKPOINT_STRIDE);
    const scanner = new RegExp(escaped, flags);
    scanner.lastIndex = checkpoints[checkpoint];
    const matches: Match[] = [];
    let ordinal = checkpoint * CHECKPOINT_STRIDE;
    let current: RegExpExecArray | null;
    while (ordinal < end && (current = scanner.exec(text)) !== null) {
      if (ordinal >= start)
        matches.push({ from: current.index, to: current.index + current[0].length });
      ordinal += 1;
    }
    return matches;
  };
  return {
    count,
    checkpointCount: checkpoints.length,
    at: (index) =>
      Number.isInteger(index) && index >= 0 && index < count
        ? slice(index, index + 1)[0]
        : undefined,
    slice,
  };
}

interface BlockRun {
  offset: number;
  index: TextSearchIndex;
}
const blockIndexes = new WeakMap<
  PMNode,
  { keyword: string; caseSensitive: boolean; runs: BlockRun[] }
>();

/** Unchanged immutable blocks reuse their count/checkpoints while typing elsewhere. */
function indexBlock(block: PMNode, keyword: string, caseSensitive: boolean): BlockRun[] {
  const cached = blockIndexes.get(block);
  if (cached?.keyword === keyword && cached.caseSensitive === caseSensitive) return cached.runs;
  const runs: BlockRun[] = [];
  let text = '';
  let offset = 1;
  const flush = () => {
    if (text) {
      const index = createTextSearch(text, keyword, caseSensitive);
      if (index.count) runs.push({ offset, index });
    }
    text = '';
  };
  block.forEach((node, pos) => {
    if (node.isText) {
      if (!text) offset = pos + 1;
      text += node.text ?? '';
    } else flush();
  });
  flush();
  blockIndexes.set(block, { keyword, caseSensitive, runs });
  return runs;
}

/** Marks do not split a visible text run; blocks and inline atoms do. */
function indexDocument(doc: PMNode, keyword: string, caseSensitive: boolean): TextSearchIndex {
  if (!keyword) return emptyIndex;
  const parts: { pos: number; ordinal: number; index: TextSearchIndex }[] = [];
  let count = 0;
  let checkpointCount = 0;
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    for (const run of indexBlock(block, keyword, caseSensitive)) {
      parts.push({ pos: pos + run.offset, ordinal: count, index: run.index });
      count += run.index.count;
      checkpointCount += run.index.checkpointCount;
    }
    return false;
  });
  if (!count) return emptyIndex;
  const findPart = (ordinal: number) => {
    let low = 0;
    let high = parts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const part = parts[middle];
      if (part.ordinal + part.index.count <= ordinal) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return {
    count,
    checkpointCount,
    at: (ordinal) => {
      if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= count) return;
      const part = parts[findPart(ordinal)];
      const match = part.index.at(ordinal - part.ordinal);
      return match ? { from: part.pos + match.from, to: part.pos + match.to } : undefined;
    },
    slice: (from, to) => {
      if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
      const start = Math.max(0, Math.trunc(from));
      const end = Math.min(count, Math.trunc(to));
      if (start >= end) return [];
      const matches: Match[] = [];
      for (let at = findPart(start); at < parts.length; at += 1) {
        const part = parts[at];
        if (part.ordinal >= end) break;
        for (const match of part.index.slice(start - part.ordinal, end - part.ordinal)) {
          matches.push({ from: part.pos + match.from, to: part.pos + match.to });
        }
      }
      return matches;
    },
  };
}

interface SearchPluginState {
  decor: DecorationSet;
  /** Only the bounded highlight window, not every occurrence in the document. */
  matches: Match[];
  windowStart: number;
  index: TextSearchIndex;
  current: number;
  count: number;
  keyword: string;
  caseSensitive: boolean;
}

type SearchMeta =
  | { type: 'search'; keyword: string; caseSensitive: boolean }
  | { type: 'step'; dir: 1 | -1 }
  | { type: 'clear' };

export const searchPluginKey = new PluginKey<SearchPluginState>('mdplus-search');
const countListeners = new WeakMap<EditorView, Set<(count: number) => void>>();

function notifyCount(view: EditorView): void {
  const count = searchPluginKey.getState(view.state)?.count ?? 0;
  countListeners.get(view)?.forEach((listener) => listener(count));
}

function highlight(match: Match, ordinal: number, current: number): Decoration {
  return Decoration.inline(
    match.from,
    match.to,
    { class: ordinal === current ? 'md-search-current' : 'md-search-hl' },
    { searchIndex: ordinal },
  );
}

function withWindow(
  doc: PMNode,
  index: TextSearchIndex,
  requestedCurrent: number,
  keyword: string,
  caseSensitive: boolean,
): SearchPluginState {
  const current = index.count ? Math.max(0, Math.min(requestedCurrent, index.count - 1)) : -1;
  const windowStart = Math.max(
    0,
    Math.min(index.count - HIGHLIGHT_LIMIT, current - Math.floor(HIGHLIGHT_LIMIT / 2)),
  );
  const matches = index.slice(windowStart, windowStart + HIGHLIGHT_LIMIT);
  return {
    index,
    matches,
    windowStart,
    current,
    count: index.count,
    keyword,
    caseSensitive,
    decor: DecorationSet.create(
      doc,
      matches.map((match, offset) => highlight(match, windowStart + offset, current)),
    ),
  };
}

const emptyState: SearchPluginState = {
  decor: DecorationSet.empty,
  matches: [],
  windowStart: 0,
  index: emptyIndex,
  current: -1,
  count: 0,
  keyword: '',
  caseSensitive: false,
};

export const searchPlugin = new Plugin<SearchPluginState>({
  key: searchPluginKey,
  state: {
    init: () => emptyState,
    apply(tr, prev, oldState, newState) {
      const meta = tr.getMeta(searchPluginKey) as SearchMeta | undefined;
      if (meta?.type === 'clear') return { ...emptyState };
      if (meta?.type === 'search') {
        return withWindow(
          newState.doc,
          indexDocument(newState.doc, meta.keyword, meta.caseSensitive),
          0,
          meta.keyword,
          meta.caseSensitive,
        );
      }
      if (meta?.type === 'step') {
        if (!prev.count) return prev;
        const next = (prev.current + meta.dir + prev.count) % prev.count;
        if (next === prev.current) return prev;
        if (next < prev.windowStart || next >= prev.windowStart + prev.matches.length) {
          return withWindow(newState.doc, prev.index, next, prev.keyword, prev.caseSensitive);
        }
        const before = prev.index.at(prev.current)!;
        const after = prev.index.at(next)!;
        const changed = [
          ...prev.decor.find(before.from, before.to, (spec) => spec.searchIndex === prev.current),
          ...prev.decor.find(after.from, after.to, (spec) => spec.searchIndex === next),
        ];
        return {
          ...prev,
          current: next,
          decor: prev.decor
            .remove(changed)
            .add(newState.doc, [
              highlight(before, prev.current, next),
              highlight(after, next, next),
            ]),
        };
      }
      if (prev.keyword && newState.doc !== oldState.doc) {
        return withWindow(
          newState.doc,
          indexDocument(newState.doc, prev.keyword, prev.caseSensitive),
          prev.current,
          prev.keyword,
          prev.caseSensitive,
        );
      }
      return prev;
    },
  },
  props: {
    decorations(state) {
      return searchPluginKey.getState(state)?.decor ?? DecorationSet.empty;
    },
  },
  view(view) {
    return {
      update(updatedView, previousState) {
        if (
          searchPluginKey.getState(updatedView.state)?.count !==
          searchPluginKey.getState(previousState)?.count
        )
          notifyCount(updatedView);
      },
      destroy() {
        countListeners.delete(view);
      },
    };
  },
});

function getView(editor: { action<T>(fn: (ctx: Ctx) => T): T }) {
  return editor.action((ctx) => ctx.get(editorViewCtx));
}

export function runSearch(
  editor: { action<T>(fn: (ctx: Ctx) => T): T },
  keyword: string,
  caseSensitive: boolean,
): void {
  const view = getView(editor);
  if (!view) return;
  view.dispatch(view.state.tr.setMeta(searchPluginKey, { type: 'search', keyword, caseSensitive }));
}

export function stepSearch(editor: { action<T>(fn: (ctx: Ctx) => T): T }, dir: 1 | -1): void {
  const view = getView(editor);
  if (!view) return;
  view.dispatch(view.state.tr.setMeta(searchPluginKey, { type: 'step', dir }));
  const state = searchPluginKey.getState(view.state);
  const match = state?.index.at(state.current);
  if (match) {
    const selection = TextSelection.create(view.state.doc, match.from, match.to);
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  }
}

export function clearSearch(editor: { action<T>(fn: (ctx: Ctx) => T): T }): void {
  const view = getView(editor);
  if (!view) return;
  view.dispatch(view.state.tr.setMeta(searchPluginKey, { type: 'clear' }));
}

export function getSearchCount(editor: { action<T>(fn: (ctx: Ctx) => T): T }): number {
  const view = getView(editor);
  if (!view) return 0;
  return searchPluginKey.getState(view.state)?.count ?? 0;
}

export function subscribeSearchCount(
  editor: { action<T>(fn: (ctx: Ctx) => T): T },
  listener: (count: number) => void,
): () => void {
  const view = getView(editor);
  let listeners = countListeners.get(view);
  if (!listeners) {
    listeners = new Set();
    countListeners.set(view, listeners);
  }
  listeners.add(listener);
  listener(searchPluginKey.getState(view.state)?.count ?? 0);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) countListeners.delete(view);
  };
}
