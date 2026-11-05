import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { EditorView } from '@milkdown/prose/view';
import type { Node as PMNode } from '@milkdown/prose/model';
import type { Ctx } from '@milkdown/kit/ctx';
import { editorViewCtx } from '@milkdown/kit/core';

/** 匹配片段 */
interface Match {
  from: number;
  to: number;
}

/** 插件内部状态 */
interface SearchPluginState {
  decor: DecorationSet;
  matches: Match[];
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

/** Literal search keeps UTF-16 offsets in the original text, including case-insensitive matches. */
export function findTextMatches(text: string, keyword: string, caseSensitive: boolean): Match[] {
  if (!keyword) return [];
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, caseSensitive ? 'gu' : 'giu');
  return [...text.matchAll(pattern)].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
}

/** Adjacent text with different marks is one visible run; blocks and inline atoms remain boundaries. */
function collectMatches(doc: PMNode, keyword: string, caseSensitive: boolean): Match[] {
  const matches: Match[] = [];
  if (!keyword) return matches;
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    let text = '';
    let start = pos + 1;
    const flush = () => {
      for (const match of findTextMatches(text, keyword, caseSensitive)) {
        matches.push({ from: start + match.from, to: start + match.to });
      }
      text = '';
    };
    block.forEach((node, offset) => {
      if (node.isText) {
        if (!text) start = pos + 1 + offset;
        text += node.text ?? '';
      } else flush();
    });
    flush();
    return false;
  });
  return matches;
}

/** 依据匹配与当前索引构建装饰集 */
function buildDecor(doc: PMNode, matches: Match[], current: number): DecorationSet {
  const decor = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === current ? 'md-search-current' : 'md-search-hl',
    }),
  );
  return DecorationSet.create(doc, decor);
}

const emptyState: SearchPluginState = {
  decor: DecorationSet.empty,
  matches: [],
  current: -1,
  count: 0,
  keyword: '',
  caseSensitive: false,
};

export const searchPlugin = new Plugin<SearchPluginState>({
  key: searchPluginKey,
  state: {
    init: () => emptyState,
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(searchPluginKey) as SearchMeta | undefined;
      if (meta) {
        if (meta.type === 'clear') return { ...emptyState };
        if (meta.type === 'search') {
          const matches = collectMatches(newState.doc, meta.keyword, meta.caseSensitive);
          const current = matches.length ? 0 : -1;
          return {
            decor: buildDecor(newState.doc, matches, current),
            matches,
            current,
            count: matches.length,
            keyword: meta.keyword,
            caseSensitive: meta.caseSensitive,
          };
        }
        if (meta.type === 'step') {
          if (!prev.matches.length) return prev;
          const next = (prev.current + meta.dir + prev.matches.length) % prev.matches.length;
          return { ...prev, current: next, decor: buildDecor(newState.doc, prev.matches, next) };
        }
      }
      // 文档变化(输入等)时,若有关键词则实时重算
      if (prev.keyword && newState.doc !== _oldState.doc) {
        const matches = collectMatches(newState.doc, prev.keyword, prev.caseSensitive);
        const current = matches.length
          ? Math.max(0, Math.min(prev.current, matches.length - 1))
          : -1;
        return {
          ...prev,
          decor: buildDecor(newState.doc, matches, current),
          matches,
          current,
          count: matches.length,
        };
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
      update(updatedView) {
        notifyCount(updatedView);
      },
      destroy() {
        countListeners.delete(view);
      },
    };
  },
});

/** 从 editor 取到 ProseMirror view */
function getView(editor: { action<T>(fn: (ctx: Ctx) => T): T }) {
  return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** 触发一次查找 */
export function runSearch(
  editor: { action<T>(fn: (ctx: Ctx) => T): T },
  keyword: string,
  caseSensitive: boolean,
): void {
  const view = getView(editor);
  if (!view) return;
  view.dispatch(view.state.tr.setMeta(searchPluginKey, { type: 'search', keyword, caseSensitive }));
}

/** 上一条 / 下一条 */
export function stepSearch(editor: { action<T>(fn: (ctx: Ctx) => T): T }, dir: 1 | -1): void {
  const view = getView(editor);
  if (!view) return;
  view.dispatch(view.state.tr.setMeta(searchPluginKey, { type: 'step', dir }));
  const ps = searchPluginKey.getState(view.state);
  const match = ps?.matches[ps.current];
  if (match) {
    const sel = TextSelection.create(view.state.doc, match.from, match.to);
    view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
  }
}

/** 清除搜索高亮 */
export function clearSearch(editor: { action<T>(fn: (ctx: Ctx) => T): T }): void {
  const view = getView(editor);
  if (!view) return;
  view.dispatch(view.state.tr.setMeta(searchPluginKey, { type: 'clear' }));
}

/** 读取当前匹配计数 */
export function getSearchCount(editor: { action<T>(fn: (ctx: Ctx) => T): T }): number {
  const view = getView(editor);
  if (!view) return 0;
  return searchPluginKey.getState(view.state)?.count ?? 0;
}

/** 订阅搜索计数变化,用于文档编辑后同步搜索栏。 */
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
