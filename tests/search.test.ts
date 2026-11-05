import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';
import { searchPlugin, searchPluginKey } from '../src/lib/search';

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
