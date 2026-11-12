import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';
import { createTextSearch, searchPlugin, searchPluginKey } from '../src/lib/search';
import { LIMITS } from '../src/config/constants';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    hard_break: { inline: true, group: 'inline' },
  },
  marks: { strong: {}, em: {}, link: { attrs: { href: {} } } },
});
function search(doc: ReturnType<typeof schema.node>, keyword: string, caseSensitive = false) {
  let state = EditorState.create({ doc, plugins: [searchPlugin] });
  state = state.apply(
    state.tr.setMeta(searchPluginKey, { type: 'search', keyword, caseSensitive }),
  );
  return state;
}
function paragraph(text: string) {
  return schema.node('paragraph', null, schema.text(text));
}

describe('visible text search', () => {
  it.each(['strong', 'em', 'link'])('matches a phrase across a %s mark', (name) => {
    const mark = schema.mark(name, name === 'link' ? { href: 'https://example.com' } : undefined);
    const doc = schema.node(
      'doc',
      null,
      schema.node('paragraph', null, [schema.text('hello '), schema.text('world', [mark])]),
    );
    const result = searchPluginKey.getState(search(doc, 'hello world'))!;
    expect(result.count).toBe(1);
    expect(result.matches).toEqual([{ from: 1, to: 12 }]);
  });

  it('preserves source offsets when case folding would expand a Unicode character', () => {
    const doc = schema.node('doc', null, paragraph('İx'));
    expect(searchPluginKey.getState(search(doc, 'x'))!.matches).toEqual([{ from: 2, to: 3 }]);
  });

  it('treats punctuation as literal text rather than a regular expression', () => {
    const doc = schema.node('doc', null, paragraph('a+b a.b a+b'));
    expect(searchPluginKey.getState(search(doc, 'a+b', true))!.matches).toEqual([
      { from: 1, to: 4 },
      { from: 9, to: 12 },
    ]);
  });

  it('does not invent a phrase across separate paragraphs or a hard break', () => {
    const doc = schema.node('doc', null, [
      paragraph('hello '),
      paragraph('world'),
      schema.node('paragraph', null, [
        schema.text('hello '),
        schema.node('hard_break'),
        schema.text('world'),
      ]),
    ]);
    expect(searchPluginKey.getState(search(doc, 'hello world'))!.count).toBe(0);
  });

  it('selects a valid current match when edits turn no results into a result', () => {
    let state = search(schema.node('doc', null, paragraph('unrelated')), 'needle');
    expect(searchPluginKey.getState(state)!.current).toBe(-1);
    state = state.apply(state.tr.insertText('needle ', 1));
    expect(searchPluginKey.getState(state)!.count).toBe(1);
    expect(searchPluginKey.getState(state)!.current).toBe(0);
  });

  it('searches without editing the document or its stored marks', () => {
    const doc = schema.node('doc', null, paragraph('Needle needle'));
    const state = search(doc, 'needle');
    expect(state.doc.eq(doc)).toBe(true);
    expect(searchPluginKey.getState(state)!.count).toBe(2);
  });
});

describe('bounded search resources', () => {
  it('keeps an exact count while bounding the materialized matches and decorations', () => {
    const count = LIMITS.searchHighlightMatches * 3;
    const result = searchPluginKey.getState(
      search(schema.node('doc', null, paragraph('a '.repeat(count))), 'a'),
    )!;
    expect(result.count).toBe(count);
    expect(result.matches.length).toBeLessThanOrEqual(LIMITS.searchHighlightMatches);
    expect(result.decor.find().length).toBeLessThanOrEqual(LIMITS.searchHighlightMatches);
  });

  it('navigates and wraps through hits beyond the highlight window', () => {
    const count = LIMITS.searchHighlightMatches * 3;
    let state = search(schema.node('doc', null, paragraph('a '.repeat(count))), 'a');
    state = state.apply(state.tr.setMeta(searchPluginKey, { type: 'step', dir: -1 }));
    const last = searchPluginKey.getState(state)!;
    expect(last.current).toBe(count - 1);
    expect(last.index.at(last.current)).toEqual({ from: (count - 1) * 2 + 1, to: count * 2 });
    expect(last.decor.find().some((decoration) => decoration.from === (count - 1) * 2 + 1)).toBe(
      true,
    );
    expect(last.matches.length).toBeLessThanOrEqual(LIMITS.searchHighlightMatches);
    state = state.apply(state.tr.setMeta(searchPluginKey, { type: 'step', dir: 1 }));
    expect(searchPluginKey.getState(state)!.current).toBe(0);
  });

  it('reuses unrelated highlights when only the current hit changes', () => {
    let state = search(schema.node('doc', null, paragraph('a '.repeat(20))), 'a');
    const previous = searchPluginKey.getState(state)!;
    const unchanged = previous.decor.find().find((decoration) => decoration.from === 21);
    state = state.apply(state.tr.setMeta(searchPluginKey, { type: 'step', dir: 1 }));
    const next = searchPluginKey.getState(state)!;
    expect(next.index).toBe(previous.index);
    expect(next.decor.find().find((decoration) => decoration.from === 21)?.spec).toBe(
      unchanged?.spec,
    );
  });

  it('uses sparse offsets instead of retaining one object for every source hit', () => {
    const count = 262144;
    const index = createTextSearch('a '.repeat(count), 'a', false);
    expect(index.count).toBe(count);
    expect(index.checkpointCount).toBe(Math.ceil(count / LIMITS.searchCheckpointMatches));
    expect(index.at(0)).toEqual({ from: 0, to: 1 });
    expect(index.at(count - 1)).toEqual({ from: (count - 1) * 2, to: count * 2 - 1 });
    expect(index.slice(1023, 1026)).toEqual([
      { from: 2046, to: 2047 },
      { from: 2048, to: 2049 },
      { from: 2050, to: 2051 },
    ]);
    expect(index.at(-1)).toBeUndefined();
    expect(index.at(count)).toBeUndefined();
    expect(index.at(Number.NaN)).toBeUndefined();
  });

  it('preserves literal and Unicode-aware matching in the sparse source index', () => {
    expect(createTextSearch('İx A+B a+b', 'a+b', false).slice(0, 5)).toEqual([
      { from: 3, to: 6 },
      { from: 7, to: 10 },
    ]);
    expect(createTextSearch('İx', 'x', false).at(0)).toEqual({ from: 1, to: 2 });
    expect(createTextSearch('anything', '', false).count).toBe(0);
  });

  it('refreshes the active window after text changes without retaining stale positions', () => {
    const count = LIMITS.searchHighlightMatches * 2;
    let state = search(schema.node('doc', null, paragraph('a '.repeat(count))), 'a');
    state = state.apply(state.tr.setMeta(searchPluginKey, { type: 'step', dir: -1 }));
    state = state.apply(state.tr.replaceWith(1, state.doc.content.size - 1, schema.text('a')));
    const result = searchPluginKey.getState(state)!;
    expect(result.count).toBe(1);
    expect(result.current).toBe(0);
    expect(result.matches).toEqual([{ from: 1, to: 2 }]);
  });
});
