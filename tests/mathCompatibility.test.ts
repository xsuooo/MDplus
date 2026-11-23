// @vitest-environment jsdom
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { DOMParser, DOMSerializer, type Node as PMNode } from '@milkdown/kit/prose/model';
import { math, katexOptionsCtx, mathInlineSchema, mathBlockSchema } from '../src/lib/math';
import katex from 'katex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Blob as NativeBlob } from 'node:buffer';
import path from 'node:path';
import { captureExport, buildExport } from '../src/lib/export';
import { DEFAULT_BODY_FONT, DEFAULT_CODE_FONT } from '../src/lib/editorFont';
import { createEditor, getCurrentState, redo, setMarkdown, undo } from '../src/lib/editor';

const editors: { editor: Editor; host: HTMLElement }[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const { editor, host } of editors.splice(0)) {
    await editor.destroy();
    host.remove();
  }
});

async function open(markdown: string, bare = false, json?: ReturnType<PMNode['toJSON']>) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = bare
    ? Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, host);
          ctx.set(defaultValueCtx, markdown);
          ctx.set(katexOptionsCtx.key, {
            throwOnError: true,
            trust: false,
            macros: { '\\R': '\\mathbb{R}' },
          });
        })
        .use(commonmark)
        .use(math)
    : createEditor(host, markdown, { onUpdate: () => {} });
  if (json) editor.config((ctx) => ctx.set(defaultValueCtx, { type: 'json', value: json }));
  editors.push({ editor, host });
  await editor.create();
  return { editor, host, view: editor.action((ctx) => ctx.get(editorViewCtx)) };
}

function formulas(doc: PMNode) {
  const result: { type: string; value: string }[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'math_inline')
      result.push({ type: node.type.name, value: node.textContent });
    if (node.type.name === 'math_block')
      result.push({ type: node.type.name, value: node.attrs.value });
  });
  return result;
}

function roundtrip(editor: Editor, doc: PMNode) {
  return editor.action((ctx) => {
    const markdown = ctx.get(serializerCtx)(doc);
    const reparsed = ctx.get(parserCtx)(markdown)!;
    expect(reparsed.toJSON()).toEqual(doc.toJSON());
    return markdown;
  });
}

function type(view: Awaited<ReturnType<typeof open>>['view'], text: string) {
  const { from, to } = view.state.selection;
  let handled = false;
  view.someProp('handleTextInput', (handler) => {
    handled = handler(view, from, to, text, () => view.state.tr.insertText(text, from, to));
    return handled;
  });
  if (!handled) view.dispatch(view.state.tr.insertText(text, from, to));
  return handled;
}

describe('math compatibility through the real editor', () => {
  it('keeps inline text, block attrs, schema keys and data-value DOM roundtrips', async () => {
    const inline = String.raw`\frac{1}{2} + \sqrt{x}`;
    const block = String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`;
    const { editor, host, view } = await open('Value $' + inline + '$.\n\n$$\n' + block + '\n$$');
    expect(formulas(view.state.doc)).toEqual([
      { type: 'math_inline', value: inline },
      { type: 'math_block', value: block },
    ]);
    editor.action((ctx) => {
      expect(mathInlineSchema.type(ctx)).toBe(view.state.schema.nodes.math_inline);
      expect(mathBlockSchema.type(ctx)).toBe(view.state.schema.nodes.math_block);
      expect(ctx.get(mathInlineSchema.key)).toBeTypeOf('function');
      expect(ctx.get(mathBlockSchema.key)).toBeTypeOf('function');
    });
    for (const [name, value, tag] of [
      ['math_inline', inline, 'SPAN'],
      ['math_block', block, 'DIV'],
    ]) {
      const dom = host.querySelector<HTMLElement>('[data-type="' + name + '"]')!;
      expect(dom.tagName).toBe(tag);
      expect(dom.dataset.value).toBe(value);
      expect(dom.querySelector('.katex')).not.toBeNull();
      expect(dom.querySelector('.katex-display')).toBeNull();
    }
    const container = document.createElement('div');
    container.append(
      DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.doc.content),
    );
    expect(formulas(DOMParser.fromSchema(view.state.schema).parse(container))).toEqual(
      formulas(view.state.doc),
    );
    roundtrip(editor, view.state.doc);
  });

  it('uses the same configured KaTeX options for both schemas without forcing display mode', async () => {
    const { host } = await open('$\\R$\n\n$$\n\\R\n$$', true);
    for (const dom of host.querySelectorAll<HTMLElement>('[data-type^="math_"]')) {
      const expected = document.createElement('span');
      katex.render(dom.dataset.value!, expected, {
        throwOnError: true,
        trust: false,
        macros: { '\\R': '\\mathbb{R}' },
      });
      expect(dom.innerHTML).toBe(expected.innerHTML);
    }
    expect(host.querySelectorAll('[data-type^="math_"]')).toHaveLength(2);
  });

  it.each([
    ['spaces and escapes', String.raw`$  x + \, y  $`, [String.raw` x + \, y `]],
    ['literal currency', String.raw`Price \$5 and lone $10.`, []],
    ['escaped dollars stay literal', String.raw`Escaped \$x\$.`, []],
    [
      'escaped dollars inside math retain legacy delimiter behavior',
      String.raw`$\text{cost: \$5}$`,
      ['\\text{cost: \\'],
    ],
    ['paired currency uses the legacy math grammar', '$5 and $10', ['5 and ']],
    ['double-dollar inline delimiter', '$$x + y$$', ['x + y']],
    ['multiline block preserves interior whitespace', '$$\n  x + y\n\n z\n$$', ['  x + y\n\n z']],
  ])('serializes and reparses %s', async (_name, markdown, values) => {
    const { editor, view } = await open(markdown);
    expect(formulas(view.state.doc).map((node) => node.value)).toEqual(values);
    roundtrip(editor, view.state.doc);
  });

  it('preserves math, currency and code through real GFM table cells and Markdown roundtrips', async () => {
    const formula = '\\frac{1}{2}';
    const markdown = [
      '| Math $x^2$ | Currency | Code | Paired currency |',
      '| --- | --- | --- | --- |',
      '| $' + formula + '$ | Price \\$5 and lone $10. | `$x$ and $5` | $5 and $10 |',
    ].join('\n');
    const { editor, host, view } = await open(markdown);
    const table = view.state.doc.firstChild!;
    expect(table.type.name).toBe('table');
    expect(table.childCount).toBe(2);
    expect(table.child(0).type.name).toBe('table_header_row');
    expect(table.child(1).type.name).toBe('table_row');
    for (let row = 0; row < table.childCount; row++) {
      expect(table.child(row).childCount).toBe(4);
      table.child(row).forEach((cell) => {
        expect(cell.type.name).toBe(row === 0 ? 'table_header' : 'table_cell');
      });
    }
    expect(formulas(table.child(0).child(0))).toEqual([{ type: 'math_inline', value: 'x^2' }]);
    expect(formulas(table.child(1).child(0))).toEqual([{ type: 'math_inline', value: formula }]);
    expect(table.child(1).child(1).textContent).toBe('Price $5 and lone $10.');
    expect(formulas(table.child(1).child(1))).toEqual([]);
    const codeCell = table.child(1).child(2);
    expect(codeCell.textContent).toBe('$x$ and $5');
    expect(formulas(codeCell)).toEqual([]);
    let codeText = '';
    codeCell.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'inlineCode'))
        codeText += node.text;
    });
    expect(codeText).toBe('$x$ and $5');
    expect(formulas(table.child(1).child(3))).toEqual([{ type: 'math_inline', value: '5 and ' }]);
    const dom = host.querySelector('table')!;
    expect(dom.querySelectorAll('tr')).toHaveLength(2);
    expect(dom.querySelectorAll('th')).toHaveLength(4);
    const cells = dom.querySelectorAll('td');
    expect(cells).toHaveLength(4);
    expect(dom.querySelector('th [data-type="math_inline"]')?.getAttribute('data-value')).toBe(
      'x^2',
    );
    expect(cells[0].querySelector('[data-type="math_inline"]')?.getAttribute('data-value')).toBe(
      formula,
    );
    expect(dom.querySelectorAll('[data-type="math_inline"] .katex')).toHaveLength(3);
    expect(cells[1].textContent).toBe('Price $5 and lone $10.');
    expect(cells[1].querySelector('[data-type="math_inline"]')).toBeNull();
    expect(cells[2].querySelector('code')?.textContent).toBe('$x$ and $5');
    expect(cells[2].querySelector('[data-type="math_inline"]')).toBeNull();
    const saved = roundtrip(editor, view.state.doc);
    const json = view.state.doc.toJSON();
    setMarkdown(editor, saved, false);
    expect(view.state.doc.toJSON()).toEqual(json);
    expect(getCurrentState(editor).markdown).toBe(saved);
  });

  it('runs the registered inline input rule and leaves unmatched dollars as text', async () => {
    const { editor, view } = await open('');
    type(view, '$x^2');
    expect(formulas(view.state.doc)).toEqual([]);
    expect(type(view, '$')).toBe(true);
    expect(formulas(view.state.doc)).toEqual([{ type: 'math_inline', value: 'x^2' }]);
    expect(view.dom.querySelector('[data-value="x^2"] .katex')).not.toBeNull();
    roundtrip(editor, view.state.doc);
  });

  it('runs the registered block input rule on double dollar plus space', async () => {
    const { editor, view } = await open('');
    type(view, '$$');
    expect(type(view, ' ')).toBe(true);
    expect(view.state.doc.firstChild!.type.name).toBe('math_block');
    expect(view.state.doc.firstChild!.attrs.value).toBe('');
    expect(view.dom.querySelector('div[data-type="math_block"]')?.getAttribute('data-value')).toBe(
      '',
    );
    roundtrip(editor, view.state.doc);
  });

  it('preserves source-to-rich, save-style normalization and history across math edits', async () => {
    const original = 'Before $x^2$.\n\n$$\n\\frac{1}{2}\n$$\n';
    const changed = 'After $y^2$.\n\n$$\n\\sqrt{z}\n$$\n';
    const { editor, view } = await open(original);
    const before = formulas(view.state.doc);
    setMarkdown(editor, changed);
    const after = formulas(view.state.doc);
    expect(after).toEqual([
      { type: 'math_inline', value: 'y^2' },
      { type: 'math_block', value: String.raw`\sqrt{z}` },
    ]);
    const saved = getCurrentState(editor).markdown;
    setMarkdown(editor, saved, false);
    expect(getCurrentState(editor).markdown).toBe(saved);
    expect(getCurrentState(editor).canUndo).toBe(true);
    undo(editor);
    expect(formulas(view.state.doc)).toEqual(before);
    expect(getCurrentState(editor).canRedo).toBe(true);
    redo(editor);
    expect(formulas(view.state.doc)).toEqual(after);
    expect(getCurrentState(editor).markdown).toBe(saved);
    setMarkdown(editor, original, false);
    expect(formulas(view.state.doc)).toEqual(before);
    roundtrip(editor, view.state.doc);
  });
  it('reconstructs saved Markdown and JSON with the same formula nodes and values', async () => {
    const { editor, view } = await open(
      'Inline $x^2$ and $\\unknown{bad}$.\n\n$$\n\\frac{1}{2}\n$$',
    );
    const values = formulas(view.state.doc);
    const saved = getCurrentState(editor).markdown;
    const json = view.state.doc.toJSON();
    const fromMarkdown = await open(saved);
    const fromJson = await open('', false, json);
    for (const restored of [fromMarkdown, fromJson]) {
      expect(restored.view.state.doc.toJSON()).toEqual(json);
      expect(formulas(restored.view.state.doc)).toEqual(values);
      expect(restored.host.querySelectorAll('[data-type^="math_"]')).toHaveLength(3);
      expect(restored.host.querySelector('.katex-error[role="alert"]')?.textContent).toBe(
        '公式有误：' + String.raw`\unknown{bad}`,
      );
      expect(getCurrentState(restored.editor).markdown).toBe(saved);
    }
  });

  it('captures and builds portable HTML using real math and bundled fonts with trust disabled', async () => {
    const markdown =
      'Inline $x^2$ and $\\href{javascript:alert(1)}{unsafe}$.\n\n$$\n\\frac{1}{2}\n$$';
    const { editor } = await open(markdown);
    const snapshot = captureExport(
      editor,
      markdown,
      'math-export',
      DEFAULT_BODY_FONT,
      DEFAULT_CODE_FONT,
      (src) => src,
    );
    expect(snapshot.content.querySelectorAll('.katex')).toHaveLength(3);
    expect(snapshot.content.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(snapshot.content.querySelector('[href]')).toBeNull();
    const root = process.cwd();
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = decodeURIComponent(new URL(value, document.baseURI).pathname);
      let file: string;
      if (
        pathname.startsWith('/src/assets/fonts/') ||
        pathname.startsWith('/node_modules/katex/dist/fonts/')
      )
        file = path.join(root, pathname.slice(1));
      else if (pathname.startsWith('/font-licenses/'))
        file = path.join(root, 'public', pathname.slice(1));
      else throw new Error('Unexpected export resource: ' + pathname);
      const bytes = await readFile(file);
      return {
        ok: true,
        status: 200,
        blob: async () =>
          new NativeBlob([bytes], {
            type: file.endsWith('.pdf') ? 'application/pdf' : 'font/woff2',
          }),
        text: async () => bytes.toString('utf8'),
      };
    });
    vi.stubGlobal(
      'FileReader',
      class {
        result: string | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(blob: Blob) {
          void blob.arrayBuffer().then(
            (bytes) => {
              this.result =
                'data:' + blob.type + ';base64,' + Buffer.from(bytes).toString('base64');
              this.onload?.();
            },
            () => this.onerror?.(),
          );
        }
      },
    );
    const html = await buildExport(snapshot);
    const exported = new window.DOMParser().parseFromString(html, 'text/html');
    expect(exported.querySelectorAll('main .katex')).toHaveLength(3);
    expect(
      [...exported.querySelectorAll('main annotation')].map((node) => node.textContent),
    ).toEqual(['x^2', String.raw`\href{javascript:alert(1)}{unsafe}`, String.raw`\frac{1}{2}`]);
    expect(exported.querySelector('main [href], main script')).toBeNull();
    expect(
      exported.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    ).toContain("default-src 'none'");
    expect(exported.querySelector('style')?.textContent).toContain('data:font/woff2;base64,');
    expect(exported.querySelector('style')?.textContent).not.toMatch(/url\(["']?fonts\//);
    expect(exported.querySelector('.export-notices')?.textContent).toContain('Copyright');
  }, 30000);

  it.each(['inline', 'block'])(
    'rejects invalid %s LaTeX at the real export capture entrypoint',
    async (kind) => {
      const { editor } = await open('safe');
      const invalid = String.raw`\unknown{<img src=x onerror=alert(1)>}`;
      const markdown = kind === 'inline' ? '$' + invalid + '$' : '$$\n' + invalid + '\n$$';
      expect(() =>
        captureExport(
          editor,
          markdown,
          'invalid',
          DEFAULT_BODY_FONT,
          DEFAULT_CODE_FONT,
          (src) => src,
        ),
      ).toThrow(katex.ParseError);
    },
  );
});
