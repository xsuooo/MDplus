import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { closeHistory } from '@milkdown/prose/history';
import { Mark, type Node as PMNode } from '@milkdown/prose/model';
import { TextSelection, type Transaction } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import {
  createDocumentSearch,
  createTextSearch,
  isSearchableTextblock,
  searchPluginKey,
  type Match,
  type TextSearchIndex,
} from './search';
import type { SourceEditorApi, SourceTextEdit } from './sourceEditorApi';

interface SearchEditor {
  action<T>(fn: (ctx: Ctx) => T): T;
}

export interface ReplaceResult {
  replaced: number;
  skipped: number;
  nextIndex?: number;
  reason?: 'unavailable' | 'unchanged';
}

const noChange = (): ReplaceResult => ({ replaced: 0, skipped: 0 });
const unavailable = (): ReplaceResult => ({ ...noChange(), reason: 'unavailable' });

/** A replacement must not assign one format or link target to differently marked text. */
function replacementMarks(doc: PMNode, match: Match): readonly Mark[] | undefined {
  const start = doc.resolve(match.from);
  const end = doc.resolve(match.to);
  if (!start.sameParent(end) || !isSearchableTextblock(start.parent)) return;
  let marks: readonly Mark[] | undefined;
  let covered = 0;
  let consistent = true;
  doc.nodesBetween(match.from, match.to, (node, pos) => {
    if (!node.isText) return !node.isInline;
    covered += Math.min(pos + node.nodeSize, match.to) - Math.max(pos, match.from);
    if (!marks) marks = node.marks;
    else if (!Mark.sameSet(marks, node.marks)) consistent = false;
    return false;
  });
  return consistent && covered === match.to - match.from ? marks : undefined;
}

function nextIndexAt(index: TextSearchIndex, position: number): number {
  if (!index.count) return -1;
  let low = 0;
  let high = index.count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (index.at(middle)!.from < position) low = middle + 1;
    else high = middle;
  }
  return low < index.count ? low : 0;
}

function editorSearch(view: EditorView, keyword: string, caseSensitive: boolean) {
  const state = searchPluginKey.getState(view.state);
  if (state?.keyword === keyword && state.caseSensitive === caseSensitive)
    return { index: state.index, current: state.current };
  return { index: createDocumentSearch(view.state.doc, keyword, caseSensitive), current: 0 };
}

function setSearch(
  tr: Transaction,
  keyword: string,
  caseSensitive: boolean,
  current: number,
): Transaction {
  return tr.setMeta(searchPluginKey, { type: 'search', keyword, caseSensitive, current });
}

function selectMatch(
  view: EditorView,
  index: TextSearchIndex,
  current: number,
  keyword: string,
  caseSensitive: boolean,
): void {
  const match = index.at(current);
  if (!match) return;
  view.dispatch(
    view.state.tr
      .setMeta(searchPluginKey, { type: 'search', keyword, caseSensitive, current })
      .setSelection(TextSelection.create(view.state.doc, match.from, match.to))
      .setMeta('addToHistory', false)
      .scrollIntoView(),
  );
}

function dispatchReplacement(view: EditorView, transaction: Transaction): void {
  view.dispatch(transaction);
  // closeHistory on the edit isolates preceding typing. This boundary also isolates subsequent typing.
  view.dispatch(closeHistory(view.state.tr).setMeta('addToHistory', false));
}

export function replaceCurrentMatch(
  editor: SearchEditor,
  keyword: string,
  replacement: string,
  caseSensitive: boolean,
): ReplaceResult {
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  if (!view || view.isDestroyed || !view.editable || view.composing) return unavailable();
  if (!keyword) return noChange();
  const { index, current } = editorSearch(view, keyword, caseSensitive);
  const selected = nextIndexAt(index, view.state.selection.from);
  const selectedMatch = index.at(selected);
  const ordinal =
    selectedMatch?.from === view.state.selection.from &&
    selectedMatch.to === view.state.selection.to
      ? selected
      : Math.max(0, current);
  const match = index.at(ordinal);
  if (!match) return noChange();
  const marks = replacementMarks(view.state.doc, match);
  if (!marks) {
    selectMatch(view, index, (ordinal + 1) % index.count, keyword, caseSensitive);
    return { replaced: 0, skipped: 1 };
  }
  if (view.state.doc.textBetween(match.from, match.to) === replacement) {
    selectMatch(view, index, (ordinal + 1) % index.count, keyword, caseSensitive);
    return { ...noChange(), reason: 'unchanged' };
  }
  const tr = closeHistory(view.state.tr);
  if (replacement) tr.replaceWith(match.from, match.to, view.state.schema.text(replacement, marks));
  else tr.delete(match.from, match.to);
  const updated = createDocumentSearch(tr.doc, keyword, caseSensitive);
  const next = nextIndexAt(updated, match.from + replacement.length);
  const target = updated.at(next);
  tr.setSelection(
    target
      ? TextSelection.create(tr.doc, target.from, target.to)
      : TextSelection.create(tr.doc, match.from + replacement.length),
  );
  setSearch(tr, keyword, caseSensitive, next);
  dispatchReplacement(view, tr.scrollIntoView());
  return { replaced: 1, skipped: 0 };
}

export function replaceAllMatches(
  editor: SearchEditor,
  keyword: string,
  replacement: string,
  caseSensitive: boolean,
): ReplaceResult {
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  if (!view || view.isDestroyed || !view.editable || view.composing) return unavailable();
  if (!keyword) return noChange();
  const original = view.state.doc;
  const { index } = editorSearch(view, keyword, caseSensitive);
  if (!index.count) return noChange();
  const tr = closeHistory(view.state.tr);
  let replaced = 0;
  let skipped = 0;
  // Frozen matches, processed from the end. Replacement text is never searched during this operation.
  for (let end = index.count; end > 0; end -= 1024) {
    const matches = index.slice(Math.max(0, end - 1024), end);
    for (let at = matches.length - 1; at >= 0; at -= 1) {
      const match = matches[at];
      const marks = replacementMarks(original, match);
      if (!marks) {
        skipped += 1;
        continue;
      }
      if (original.textBetween(match.from, match.to) === replacement) continue;
      if (replacement)
        tr.replaceWith(match.from, match.to, view.state.schema.text(replacement, marks));
      else tr.delete(match.from, match.to);
      replaced += 1;
    }
  }
  if (!replaced) return { replaced, skipped, reason: skipped ? undefined : 'unchanged' };
  const updated = createDocumentSearch(tr.doc, keyword, caseSensitive);
  setSearch(tr, keyword, caseSensitive, nextIndexAt(updated, tr.selection.from));
  dispatchReplacement(view, tr);
  return { replaced, skipped };
}

export function replaceSourceMatch(
  api: SourceEditorApi,
  keyword: string,
  replacement: string,
  caseSensitive: boolean,
  current = -1,
): ReplaceResult {
  if (!keyword) return noChange();
  const before = api.read();
  const index = createTextSearch(before.text, keyword, caseSensitive);
  if (!index.count) return noChange();
  const selected = nextIndexAt(index, before.start);
  const selectedMatch = index.at(selected);
  const ordinal =
    selectedMatch?.from === before.start && selectedMatch.to === before.end
      ? selected
      : current >= 0 && current < index.count
        ? current
        : 0;
  const match = index.at(ordinal)!;
  if (before.text.slice(match.from, match.to) === replacement)
    return { ...noChange(), nextIndex: (ordinal + 1) % index.count, reason: 'unchanged' };
  const text = before.text.slice(0, match.from) + replacement + before.text.slice(match.to);
  const updated = createTextSearch(text, keyword, caseSensitive);
  const next = nextIndexAt(updated, match.from + replacement.length);
  const target = updated.at(next);
  const caret = match.from + replacement.length;
  const applied = api.applyEdits([{ ...match, text: replacement }], {
    start: target?.from ?? caret,
    end: target?.to ?? caret,
  });
  return applied ? { replaced: 1, skipped: 0, nextIndex: next } : unavailable();
}

export function replaceAllSourceMatches(
  api: SourceEditorApi,
  keyword: string,
  replacement: string,
  caseSensitive: boolean,
): ReplaceResult {
  if (!keyword) return noChange();
  const before = api.read();
  const index = createTextSearch(before.text, keyword, caseSensitive);
  const edits: SourceTextEdit[] = [];
  for (let start = 0; start < index.count; start += 1024) {
    for (const match of index.slice(start, start + 1024)) {
      if (before.text.slice(match.from, match.to) !== replacement)
        edits.push({ ...match, text: replacement });
    }
  }
  if (!edits.length) return index.count ? { ...noChange(), reason: 'unchanged' } : noChange();
  return api.applyEdits(edits)
    ? { replaced: edits.length, skipped: 0, nextIndex: -1 }
    : unavailable();
}
