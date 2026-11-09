// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm, keepTableAlignPlugin } from '@milkdown/kit/preset/gfm';
import { $prose } from '@milkdown/kit/utils';
import { prism } from '@milkdown/plugin-prism';
import { refractor } from 'refractor';
import { history, closeHistory, redo, undo } from '@milkdown/prose/history';
import { EditorState, Plugin, TextSelection, type Transaction } from '@milkdown/prose/state';
import { Fragment, type Node } from '@milkdown/prose/model';
import type { DecorationSet } from '@milkdown/prose/view';
import { configureMarkdownSchemas } from '../src/lib/markdownSchemas';
import { createNodeIndex } from '../src/lib/documentNodes';
import {
  configurePrismTransactions,
  createTableAlignmentPlugin,
} from '../src/lib/editorPerformance';

const editors: { editor: Editor; host: HTMLElement }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { editor, host } of editors.splice(0)) {
    await editor.destroy();
    host.remove();
  }
});

async function fixture(markdown: string, optimized: boolean) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, markdown);
    })
    .config(configureMarkdownSchemas)
    .use(commonmark)
    .use(
      optimized
        ? gfm.map((plugin) =>
            plugin === keepTableAlignPlugin ? $prose(createTableAlignmentPlugin) : plugin,
          )
        : gfm,
    )
    .use(prism);
  if (optimized) editor.config(configurePrismTransactions);
  await editor.create();
  editors.push({ editor, host });
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const plugin = (name: string) => {
    const found = view.state.plugins.find((candidate) =>
      (candidate as Plugin & { key: string }).key.startsWith(`${name}$`),
    );
    expect(found, `Expected ${name} to remain installed`).toBeDefined();
    return found!;
  };
  return { view, plugin };
}

function nodes(doc: Node, type: string) {
  const result: { node: Node; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === type) result.push({ node, pos });
  });
  return result;
}

describe('incremental document indexes', () => {
  it('reuses unchanged nested subtrees while mapping headings and images after edits', async () => {
    const { view } = await fixture(
      '# Start\n\n> ## Nested\n>\n> ![photo](photo.png)\n\n| A | B |\n| --- | --- |\n| one | two |\n\nEnd.',
      true,
    );
    const headings = createNodeIndex('heading');
    const images = createNodeIndex('image');
    const first = view.state.doc;
    expect(headings(first)).toEqual(nodes(first, 'heading'));
    expect(images(first)).toEqual(nodes(first, 'image'));
    const table = nodes(first, 'table')[0].node;
    const visit = vi.spyOn(table, 'forEach');
    const next = view.state.tr.insertText('Longer ', 1).doc;
    expect(headings(next)).toEqual(nodes(next, 'heading'));
    expect(images(next)).toEqual(nodes(next, 'image'));
    expect(images(first)).toEqual(nodes(first, 'image'));
    expect(visit).not.toHaveBeenCalled();
    expect(headings(next)).toBe(headings(next));
  });
});

describe('table alignment transactions', () => {
  it('matches GFM for mixed edits, reused rows, nested tables and undo/redo', async () => {
    const { view, plugin } = await fixture(
      '| A | B |\n| :--- | ---: |\n| a | b |\n| c | d |\n\nOutside.\n\n> | X | Y |\n> | --- | :---: |\n> | x | y |',
      false,
    );
    const reference = plugin('MILKDOWN_KEEP_TABLE_ALIGN_PLUGIN');
    let states = [reference, createTableAlignmentPlugin()].map((alignment) =>
      EditorState.create({ doc: view.state.doc, plugins: [alignment, history()] }),
    );
    let edits = 0;
    const edit = (change: (state: EditorState) => Transaction) => {
      states = states.map((state) => state.applyTransaction(closeHistory(change(state))).state);
      expect(states[1].doc.toJSON()).toEqual(states[0].doc.toJSON());
      states[1].doc.check();
      edits++;
    };
    edit((state) => state.tr.insertText('edited ', nodes(state.doc, 'table_cell')[0].pos + 2));
    edit((state) => {
      const header = nodes(state.doc, 'table_header')[0];
      const cell = nodes(state.doc, 'table_cell')[2];
      return state.tr
        .setNodeMarkup(header.pos, undefined, { ...header.node.attrs, alignment: 'center' })
        .setNodeMarkup(cell.pos, undefined, { ...cell.node.attrs, alignment: 'right' });
    });
    edit((state) => {
      const table = nodes(state.doc, 'table')[0];
      return state.tr.insert(table.pos + table.node.nodeSize - 1, table.node.lastChild!);
    });
    edit((state) => {
      const row = nodes(state.doc, 'table_row')[0];
      return state.tr.delete(row.pos, row.pos + row.node.nodeSize);
    });
    edit((state) => {
      const table = nodes(state.doc, 'table')[1];
      return state.tr.insert(
        state.doc.content.size,
        state.schema.nodes.blockquote.create(null, table.node),
      );
    });
    edit((state) => {
      const header = nodes(state.doc, 'table_header').at(-1)!;
      return state.tr.setNodeMarkup(header.pos, undefined, {
        ...header.node.attrs,
        alignment: 'left',
      });
    });
    edit((state) => {
      const table = state.doc.firstChild!;
      const rows: Node[] = [];
      table.forEach((row, _offset, index) => {
        const cells: Node[] = [];
        row.forEach((cell) => cells.push(cell));
        const type = state.schema.nodes[index === 0 ? 'table_header' : 'table_cell'];
        cells.push(
          type.create({ alignment: index === 0 ? 'center' : 'left' }, [
            state.schema.nodes.paragraph.create(null, state.schema.text('new')),
          ]),
        );
        rows.push(row.copy(Fragment.fromArray(cells)));
      });
      return state.tr.replaceWith(0, table.nodeSize, table.type.create(table.attrs, rows));
    });
    edit((state) => {
      const table = state.doc.firstChild!;
      const rows: Node[] = [];
      table.forEach((row) => rows.push(row.copy(row.content.cut(row.firstChild!.nodeSize))));
      return state.tr.replaceWith(0, table.nodeSize, table.type.create(table.attrs, rows));
    });
    const final = states[1].doc;
    for (const command of [undo, redo]) {
      for (let index = 0; index < edits; index++) {
        states = states.map((state) => {
          let next = state;
          expect(command(state, (tr) => (next = state.applyTransaction(tr).state))).toBe(true);
          return next;
        });
        expect(states[1].doc.toJSON()).toEqual(states[0].doc.toJSON());
      }
    }
    expect(states[1].doc.eq(final)).toBe(true);
  });

  it('does not scan validated tables or append empty transactions for outside typing', async () => {
    const { view } = await fixture(
      '| A | B |\n| :--- | ---: |\n' + '| one | two |\n'.repeat(500) + '\nOutside.',
      true,
    );
    let state = EditorState.create({
      doc: view.state.doc,
      plugins: [createTableAlignmentPlugin()],
    });
    state = state.applyTransaction(state.tr.insertText('a', state.doc.content.size - 1)).state;
    const table = state.doc.firstChild!;
    const visit = vi.spyOn(table, 'forEach');
    for (let index = 0; index < 5; index++) {
      const result = state.applyTransaction(state.tr.insertText('b', state.doc.content.size - 1));
      expect(result.transactions).toHaveLength(1);
      state = result.state;
    }
    expect(state.doc.firstChild).toBe(table);
    expect(visit).not.toHaveBeenCalled();
  });
});

describe('Prism transaction guard', () => {
  it('keeps highlight ranges identical while bypassing selection and unrelated text scans', async () => {
    const markdown =
      'Before.\n\n```javascript\nconst one = 1;\n```\n\nBetween.\n\n```typescript\nconst two: number = 2;\n```\n\nAfter.';
    const reference = await fixture(markdown, false);
    const optimized = await fixture(markdown, true);
    const plugins = [reference, optimized].map(
      (current) => current.plugin('MILKDOWN_PRISM') as Plugin<DecorationSet>,
    );
    let states = plugins.map((plugin) =>
      EditorState.create({ doc: reference.view.state.doc, plugins: [plugin] }),
    );
    const decorations = (index: number) =>
      plugins[index]
        .getState(states[index])!
        .find()
        .map((decoration) => ({
          from: decoration.from,
          to: decoration.to,
          attrs: (decoration as unknown as { type: { attrs: object } }).type.attrs,
        }));
    const edit = (change: (state: EditorState) => Transaction) => {
      states = states.map((state) => state.apply(change(state)));
      expect(decorations(1)).toEqual(decorations(0));
    };
    expect(decorations(1).length).toBeGreaterThan(0);
    expect(decorations(1)).toEqual(decorations(0));
    const firstDoc = states[1].doc;
    const visit = vi.spyOn(firstDoc, 'descendants');
    states[1] = states[1].apply(states[1].tr.setSelection(TextSelection.create(firstDoc, 3)));
    expect(visit).not.toHaveBeenCalled();
    states[1] = states[1].apply(states[1].tr.setMeta('unrelated', true));
    expect(visit).not.toHaveBeenCalled();
    visit.mockRestore();
    edit((state) => state.tr.insertText('prefix ', 1));
    const scanCode = vi.spyOn(states[1].doc, 'descendants');
    edit((state) => state.tr.insertText('suffix', state.doc.content.size - 1));
    expect(scanCode).not.toHaveBeenCalled();
    scanCode.mockRestore();
    edit((state) =>
      state.tr.setSelection(
        TextSelection.create(state.doc, nodes(state.doc, 'code_block')[1].pos + 1),
      ),
    );
    edit((state) => state.tr.insertText('let '));
    edit((state) => {
      const block = nodes(state.doc, 'code_block')[1];
      return state.tr.setNodeMarkup(block.pos, undefined, {
        ...block.node.attrs,
        language: 'javascript',
      });
    });
    edit((state) => {
      const block = nodes(state.doc, 'code_block')[0];
      return state.tr.delete(block.pos, block.pos + block.node.nodeSize);
    });
    edit((state) => {
      const block = nodes(state.doc, 'code_block')[0];
      const tr = state.tr.delete(block.pos, block.pos + block.node.nodeSize);
      return tr.insert(tr.doc.content.size, block.node);
    });
    expect(decorations(1).length).toBeGreaterThan(0);
  });

  it('rehighlights only the edited code block and retains other decorations', async () => {
    const { view, plugin } = await fixture(
      '```javascript\nconst a = 1\n```\n\n```javascript\nconst b = 2\n```\n\n```javascript\nconst c = 3\n```',
      true,
    );
    const highlight = vi.spyOn(refractor, 'highlight');

    view.dispatch(view.state.tr.insertText('x', 2));

    const first = view.state.doc.firstChild!;
    const secondPos = first.nodeSize;
    const second = view.state.doc.nodeAt(secondPos)!;
    const decorations = plugin('MILKDOWN_PRISM').getState(view.state)!;
    expect(decorations.find(secondPos + 1, secondPos + second.nodeSize - 1).length).toBeGreaterThan(
      0,
    );
    expect(highlight).toHaveBeenCalledTimes(1);
    expect(highlight.mock.calls[0][0]).toContain('cxonst');
  });
});
