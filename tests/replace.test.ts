// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Ctx } from '@milkdown/kit/ctx';
import { Schema, type Node as PMNode } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { history, undo, redo, undoDepth } from '@milkdown/prose/history';
import { replaceAllMatches, replaceCurrentMatch } from '../src/lib/replace';
import { runSearch, searchPlugin, searchPluginKey } from '../src/lib/search';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 2 } },
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    blockquote: { group: 'block', content: 'block+', toDOM: () => ['blockquote', 0] },
    bullet_list: { group: 'block', content: 'list_item+', toDOM: () => ['ul', 0] },
    list_item: { content: 'paragraph block*', toDOM: () => ['li', 0] },
    table: { group: 'block', content: 'table_row+', toDOM: () => ['table', ['tbody', 0]] },
    table_row: { content: 'table_cell+', toDOM: () => ['tr', 0] },
    table_cell: { content: 'paragraph+', toDOM: () => ['td', 0] },
    code_block: {
      group: 'block',
      content: 'text*',
      marks: '',
      attrs: { language: { default: '' } },
      toDOM: () => ['pre', ['code', 0]],
    },
    math_block: {
      group: 'block',
      content: 'text*',
      atom: true,
      attrs: { value: { default: '' } },
      toDOM: (node) => ['div', { 'data-type': 'math_block' }, node.attrs.value],
    },
    math_inline: {
      group: 'inline',
      inline: true,
      content: 'text*',
      atom: true,
      toDOM: (node) => ['span', { 'data-type': 'math_inline' }, node.textContent],
    },
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { src: {} },
      toDOM: (node) => ['img', { src: node.attrs.src }],
    },
    hard_break: { group: 'inline', inline: true, toDOM: () => ['br'] },
    text: { group: 'inline' },
  },
  marks: {
    strong: { toDOM: () => ['strong', 0] },
    em: { toDOM: () => ['em', 0] },
    code: { toDOM: () => ['code', 0] },
    link: {
      attrs: { href: {}, title: { default: null } },
      toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title }, 0],
    },
  },
});
const views: EditorView[] = [];
function paragraph(text: string, marks = [] as ReturnType<typeof schema.mark>[]) {
  return schema.node('paragraph', null, text ? schema.text(text, marks) : undefined);
}
function mount(content: PMNode | PMNode[], keyword = 'needle', caseSensitive = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: schema.node('doc', null, content),
      plugins: [history(), searchPlugin],
    }),
  });
  views.push(view);
  const editor = {
    action: <T>(fn: (ctx: Ctx) => T): T => fn({ get: () => view } as unknown as Ctx),
  };
  runSearch(editor, keyword, caseSensitive);
  return { view, editor };
}
afterEach(() => {
  for (const view of views.splice(0)) {
    const host = view.dom.parentElement;
    view.destroy();
    host?.remove();
  }
});

describe('rich text replacement', () => {
  it('preserves headings, lists, tables, inline formats and exact link targets', () => {
    const strong = schema.mark('strong');
    const code = schema.mark('code');
    const link = schema.mark('link', {
      href: 'https://example.com/a?needle=1',
      title: 'needle title',
    });
    const { view, editor } = mount([
      schema.node('heading', { level: 3 }, schema.text('needle', [strong])),
      schema.node('bullet_list', null, schema.node('list_item', null, paragraph('needle', [code]))),
      schema.node(
        'table',
        null,
        schema.node(
          'table_row',
          null,
          schema.node('table_cell', null, paragraph('needle', [link])),
        ),
      ),
    ]);
    const beforeStructure = view.state.doc.toJSON();

    expect(replaceAllMatches(editor, 'needle', '中文', false)).toMatchObject({
      replaced: 3,
      skipped: 0,
    });

    expect(view.state.doc.child(0).type.name).toBe('heading');
    expect(view.state.doc.child(0).attrs.level).toBe(3);
    expect(view.state.doc.child(0).firstChild!.marks).toEqual([strong]);
    expect(view.state.doc.child(1).firstChild!.firstChild!.firstChild!.marks).toEqual([code]);
    const cell = view.state.doc.child(2).firstChild!.firstChild!;
    expect(cell.firstChild!.firstChild!.marks).toEqual([link]);
    expect(cell.textContent).toBe('中文');
    expect(view.state.doc.toJSON()).toEqual(
      JSON.parse(JSON.stringify(beforeStructure).replace(/"text":"needle"/g, '"text":"中文"')),
    );
    expect(undoDepth(view.state)).toBe(1);
    undo(view.state, view.dispatch);
    expect(view.state.doc.toJSON()).toEqual(beforeStructure);
  });

  it('keeps cross-format phrases searchable while skipping their replacement', () => {
    const strong = schema.mark('strong');
    const mixed = schema.node('paragraph', null, [
      schema.text('hello '),
      schema.text('world', [strong]),
    ]);
    const { view, editor } = mount([mixed, paragraph('hello world', [strong])], 'hello world');
    expect(searchPluginKey.getState(view.state)!.count).toBe(2);

    expect(replaceAllMatches(editor, 'hello world', 'updated', false)).toMatchObject({
      replaced: 1,
      skipped: 1,
    });

    expect(view.state.doc.firstChild!.eq(mixed)).toBe(true);
    expect(view.state.doc.lastChild!.firstChild!.marks).toEqual([strong]);
    expect(view.state.doc.lastChild!.textContent).toBe('updated');
    expect(searchPluginKey.getState(view.state)!.count).toBe(1);
  });

  it('skips a phrase spanning distinct link destinations', () => {
    const first = schema.mark('link', { href: 'https://first.example' });
    const second = schema.mark('link', { href: 'https://second.example' });
    const original = schema.node('paragraph', null, [
      schema.text('hello ', [first]),
      schema.text('world', [second]),
    ]);
    const { view, editor } = mount(original, 'hello world');

    expect(replaceAllMatches(editor, 'hello world', 'joined', false)).toMatchObject({
      replaced: 0,
      skipped: 1,
    });

    expect(view.state.doc.firstChild!.eq(original)).toBe(true);
    expect(undoDepth(view.state)).toBe(0);
  });

  it('advances after a skipped current hit and replaces the next occurrence', () => {
    const mixed = schema.node('paragraph', null, [
      schema.text('hello '),
      schema.text('world', [schema.mark('em')]),
    ]);
    const { view, editor } = mount([mixed, paragraph('hello world')], 'hello world');

    expect(replaceCurrentMatch(editor, 'hello world', 'changed', false)).toMatchObject({
      replaced: 0,
      skipped: 1,
    });
    expect(searchPluginKey.getState(view.state)!.current).toBe(1);
    expect(view.state.selection.from).toBe(mixed.nodeSize + 1);
    expect(replaceCurrentMatch(editor, 'hello world', 'changed', false)).toMatchObject({
      replaced: 1,
      skipped: 0,
    });

    expect(view.state.doc.firstChild!.eq(mixed)).toBe(true);
    expect(view.state.doc.lastChild!.textContent).toBe('changed');
  });

  it('replaces the selected occurrence and moves beyond text introduced by replacement', () => {
    const { view, editor } = mount(paragraph('needle needle needle'));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 14)));

    expect(replaceCurrentMatch(editor, 'needle', 'needle needle', false)).toMatchObject({
      replaced: 1,
      skipped: 0,
    });

    expect(view.state.doc.textContent).toBe('needle needle needle needle');
    expect(view.state.selection.from).toBe(22);
    expect(view.state.selection.to).toBe(28);
    expect(searchPluginKey.getState(view.state)!.current).toBe(3);
  });

  it('uses frozen matches when replacement contains the query', () => {
    const { view, editor } = mount(paragraph('a a'), 'a');

    expect(replaceAllMatches(editor, 'a', 'aa', false)).toMatchObject({ replaced: 2, skipped: 0 });

    expect(view.state.doc.textContent).toBe('aa aa');
    expect(searchPluginKey.getState(view.state)!.count).toBe(4);
    expect(undoDepth(view.state)).toBe(1);
  });

  it('supports deletion without removing blocks or changing neighboring marks', () => {
    const strong = schema.mark('strong');
    const { view, editor } = mount([
      paragraph('needle'),
      schema.node('paragraph', null, [
        schema.text('prefix ', [strong]),
        schema.text('needle'),
        schema.text(' suffix', [strong]),
      ]),
    ]);

    expect(replaceAllMatches(editor, 'needle', '', false)).toMatchObject({
      replaced: 2,
      skipped: 0,
    });

    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.firstChild!.content.size).toBe(0);
    expect(view.state.doc.lastChild!.textContent).toBe('prefix  suffix');
    expect(view.state.doc.lastChild!.firstChild!.marks).toEqual([strong]);
  });

  it('treats both query and replacement as literal strings and respects case sensitivity', () => {
    const { view, editor } = mount(paragraph('A+B a+b İx'), 'a+b', true);

    expect(replaceAllMatches(editor, 'a+b', '$&', true)).toMatchObject({ replaced: 1, skipped: 0 });
    expect(view.state.doc.textContent).toBe('A+B $& İx');
    expect(replaceAllMatches(editor, 'x', '中文', false)).toMatchObject({
      replaced: 1,
      skipped: 0,
    });
    expect(view.state.doc.textContent).toBe('A+B $& İ中文');
  });

  it('excludes Mermaid and formula source, inline atoms and cross-block phrases', () => {
    const mermaid = schema.node('code_block', { language: 'Mermaid' }, schema.text('needle'));
    const formula = schema.node('math_block', { value: 'needle' }, schema.text('needle'));
    const inline = schema.node('paragraph', null, [
      schema.text('hello '),
      schema.node('math_inline', null, schema.text('needle')),
      schema.text('world'),
    ]);
    const image = schema.node('paragraph', null, [
      schema.text('hello '),
      schema.node('image', { src: 'needle.png' }),
      schema.text('world'),
    ]);
    const { view, editor } = mount([
      mermaid,
      formula,
      inline,
      image,
      schema.node('code_block', { language: 'js' }, schema.text('needle')),
    ]);

    expect(searchPluginKey.getState(view.state)!.count).toBe(1);
    expect(replaceAllMatches(editor, 'needle', 'updated', false)).toMatchObject({
      replaced: 1,
      skipped: 0,
    });

    expect(view.state.doc.child(0).eq(mermaid)).toBe(true);
    expect(view.state.doc.child(1).eq(formula)).toBe(true);
    expect(view.state.doc.child(2).eq(inline)).toBe(true);
    expect(view.state.doc.child(3).eq(image)).toBe(true);
    expect(view.state.doc.lastChild!.textContent).toBe('updated');
    expect(replaceAllMatches(editor, 'hello world', 'joined', false)).toMatchObject({
      replaced: 0,
      skipped: 0,
    });
  });

  it('makes all replacements one undo step separated from typing before and after', () => {
    const { view, editor } = mount(paragraph('needle needle'));
    view.dispatch(view.state.tr.insertText(' before', view.state.doc.content.size - 1));
    const beforeReplacement = view.state.doc;

    replaceAllMatches(editor, 'needle', 'updated', false);
    const afterReplacement = view.state.doc;
    view.dispatch(view.state.tr.insertText(' after', view.state.doc.content.size - 1));
    expect(undoDepth(view.state)).toBe(3);

    undo(view.state, view.dispatch);
    expect(view.state.doc.eq(afterReplacement)).toBe(true);
    undo(view.state, view.dispatch);
    expect(view.state.doc.eq(beforeReplacement)).toBe(true);
    undo(view.state, view.dispatch);
    expect(view.state.doc.textContent).toBe('needle needle');
    redo(view.state, view.dispatch);
    redo(view.state, view.dispatch);
    expect(view.state.doc.eq(afterReplacement)).toBe(true);
  });

  it('creates no history for an unchanged replacement and rejects an active composition', () => {
    const { view, editor } = mount(paragraph('needle'));
    expect(replaceAllMatches(editor, 'needle', 'needle', false)).toMatchObject({
      replaced: 0,
      skipped: 0,
      reason: 'unchanged',
    });
    expect(undoDepth(view.state)).toBe(0);
    Object.defineProperty(view, 'composing', { configurable: true, value: true });
    expect(replaceAllMatches(editor, 'needle', 'updated', false)).toMatchObject({
      reason: 'unavailable',
    });
    expect(view.state.doc.textContent).toBe('needle');
  });
});
