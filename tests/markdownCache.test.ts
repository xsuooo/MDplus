// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  parserCtx,
  serializerCtx,
  editorViewCtx,
  remarkCtx,
  remarkStringifyOptionsCtx,
} from '@milkdown/kit/core';
import { commonmark, imageSchema, paragraphSchema } from '@milkdown/kit/preset/commonmark';
import {
  gfm,
  remarkGFMPlugin,
  tableHeaderRowSchema,
  tableRowSchema,
} from '@milkdown/kit/preset/gfm';
import { defaultHandlers } from 'mdast-util-to-markdown';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { gfmTableToMarkdown } from 'mdast-util-gfm-table';
import { createEditor } from '../src/lib/editor';
import {
  cacheMarkdownParser,
  cachedDocSchema,
  configureMarkdownSchemas,
  createSimpleDocument,
  parseSimpleMarkdown,
} from '../src/lib/markdownSchemas';

const editors: { editor: Editor; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const { editor, host } of editors.splice(0)) {
    await editor.destroy();
    host.remove();
  }
});
async function fixture(cached: boolean, resolve: (src: string) => string = (src) => src) {
  const host = document.createElement('div');
  document.body.append(host);
  const paragraph = vi.fn();
  const strong = vi.fn(defaultHandlers.strong);
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, 'First **paragraph**.\n\n## Heading\n\nLast paragraph.');
    })
    .config((ctx) => {
      const rows = [tableHeaderRowSchema, tableRowSchema].map((row) => ({
        key: row.key,
        schema: ctx.get(row.key),
      }));
      configureMarkdownSchemas(ctx);
      if (!cached) {
        for (const row of rows) ctx.set(row.key, row.schema);
        ctx.update(remarkStringifyOptionsCtx, (options) => ({
          ...options,
          handlers: {
            ...options.handlers,
            table: gfmTableToMarkdown(ctx.get(remarkGFMPlugin.options.key)).handlers!.table!,
          },
        }));
      }
      ctx.update(remarkStringifyOptionsCtx, (options) => ({
        ...options,
        handlers: { ...options.handlers, strong },
      }));
    })
    .config((ctx) => {
      ctx.update(paragraphSchema.key, (original) => (ctx) => {
        const schema = original(ctx);
        return {
          ...schema,
          toMarkdown: {
            ...schema.toMarkdown,
            runner: (state, node) => {
              paragraph(node);
              schema.toMarkdown.runner(state, node);
            },
          },
        };
      });
      ctx.update(imageSchema.key, (original) => (ctx) => {
        const schema = original(ctx);
        return {
          ...schema,
          toMarkdown: {
            ...schema.toMarkdown,
            runner: (state, node) =>
              schema.toMarkdown.runner(
                state,
                node.type.create({ ...node.attrs, src: resolve(node.attrs.src) }),
              ),
          },
        };
      });
    })
    .use(commonmark)
    .use(gfm);
  if (cached) editor.use(cachedDocSchema);
  await editor.create();
  editors.push({ editor, host });
  return {
    editor,
    paragraph,
    strong,
    ...editor.action((ctx) => ({
      parse: ctx.get(parserCtx),
      serialize: ctx.get(serializerCtx),
      view: ctx.get(editorViewCtx),
    })),
  };
}
describe('Markdown block cache', () => {
  it('parses identical text once while keeping mutable consumer trees independent', async () => {
    const { editor, parse } = await fixture(false);
    editor.action((ctx) => {
      const remark = ctx.get(remarkCtx);
      const original = vi.spyOn(remark, 'parse');
      const restore = cacheMarkdownParser(ctx);
      try {
        const text = '# Heading **bold**\n\nOriginal paragraph.';
        const first = remark.parse(text);
        first.children.length = 0;
        expect(remark.parse(text).children).toHaveLength(2);
        expect(parse(text)!.textContent).toContain('Original paragraph.');
        expect(original).toHaveBeenCalledTimes(1);
        expect(parse('# Changed **bold**')!.textContent).toBe('Changed bold');
        expect(original).toHaveBeenCalledTimes(2);
        remark.parse({ value: '# File input' });
        expect(original).toHaveBeenCalledTimes(3);
      } finally {
        restore();
      }
      remark.parse('# Changed');
      expect(original).toHaveBeenCalledTimes(4);
    });
  });
  it('matches the existing serializer across root, nested, escaped and adjacent blocks', async () => {
    const reference = await fixture(false);
    const cached = await fixture(true);
    const samples = [
      '# 标题 **strong**\n\nEnglish 中文 *italic* `code` [link](./file.md "title").\n\nLast.',
      '- first\n- second\n\nParagraph after a list.\n\n> quote\n>\n> another **paragraph**',
      '3. first\n\n4. second\n\n- [x] checked\n- [ ] unchecked',
      '| left | right |\n| --- | --- |\n| *one* | `two` |\n\nAfter table.',
      '| left | center | right |\n| :--- | :---: | ---: |\n| a\\|b | `a\\|b` | **中文** |\n\n| One | Two |\n| --- | --- |\n| x | y |',
      '> | left | right |\n> | --- | --- |\n> | nested | table |\n\n- item\n\n  | A | B |\n  | --- | --- |\n  | one | two |',
      '```js\nconst value = "test";\n```\n\n    indented\n\n---\n\nAfter code.',
      'First  \nline\n\n\\# literal heading\n\n1\\. literal ordered list\n\nA \\* literal * emphasis.',
      '![first](./one.png)\n\nBefore ![inline](./two.png "title") after.\n\n![reference][image]\n\n[image]: ./three.png',
      '> nested\n> - first\n>   - second\n>\n> last\n\nFollowing paragraph.',
    ];
    for (const sample of samples) {
      const doc = cached.parse(sample)!;
      const expected = reference.serialize(reference.parse(sample)!);
      expect(cached.serialize(doc)).toBe(expected);
      expect(cached.serialize(doc)).toBe(expected);
      expect(cached.serialize(cached.parse(expected)!)).toBe(expected);
      doc.check();
    }
  });
  it('reuses unchanged paragraphs and only transforms the edited paragraph', async () => {
    const { view, paragraph, serialize } = await fixture(true);
    serialize(view.state.doc);
    paragraph.mockClear();
    serialize(view.state.doc);
    expect(paragraph).not.toHaveBeenCalled();
    const original = view.state.doc;
    const next = view.state.tr.insertText('Latest ', view.state.doc.content.size - 1).doc;
    expect(next.firstChild).toBe(original.firstChild);
    expect(serialize(next)).toContain('Latest');
    expect(paragraph).toHaveBeenCalledTimes(1);
    expect(serialize(original)).not.toContain('Latest');
  });
  it('does not cache image URLs that change without a document edit', async () => {
    let directory = './one/';
    const { parse, serialize } = await fixture(true, (src) => directory + src);
    const doc = parse('![photo](photo.png)\n\nUnchanged text.')!;
    expect(serialize(doc)).toContain('./one/photo.png');
    directory = './two/';
    expect(serialize(doc)).toContain('./two/photo.png');
    expect(serialize(doc)).not.toContain('./one/photo.png');
  });
  it('reuses unchanged table cells when typing outside a large table', async () => {
    const { parse, serialize, paragraph, view } = await fixture(true);
    const doc = parse('| A | B |\n| --- | --- |\n' + '| one | two |\n'.repeat(500) + '\nAfter.')!;
    const initial = serialize(doc);
    paragraph.mockClear();
    expect(serialize(doc)).toBe(initial);
    expect(paragraph).not.toHaveBeenCalled();
    const next = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    next.insertText('Latest ', next.doc.content.size - 1);
    expect(serialize(next.doc)).toContain('Latest');
    expect(paragraph).toHaveBeenCalledTimes(1);
    expect(serialize(doc)).toBe(initial);
  });
  it('keeps table image references live and invalidates an edited cell', async () => {
    let directory = './one/';
    const { parse, serialize, view } = await fixture(true, (src) => directory + src);
    const doc = parse('| A | B |\n| --- | --- |\n| ![photo](photo.png) | original |')!;
    expect(serialize(doc)).toContain('./one/photo.png');
    directory = './two/';
    expect(serialize(doc)).toContain('./two/photo.png');
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    const pos = tr.doc.content.size - 4;
    tr.insertText(' edited', pos);
    expect(serialize(tr.doc)).toContain('edited');
    expect(serialize(doc)).not.toContain('edited');
  });
  it('only transforms the changed row and re-escapes its cells during table input', async () => {
    const { parse, serialize, paragraph, strong, view } = await fixture(true);
    const reference = await fixture(false);
    const doc = parse('| A | B |\n| --- | --- |\n' + '| **one** | two |\n'.repeat(200))!;
    const initial = serialize(doc);
    paragraph.mockClear();
    strong.mockClear();
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    tr.insertText('changed', doc.firstChild!.firstChild!.nodeSize + 5);
    const updated = serialize(tr.doc);
    expect(updated).toContain('changed');
    expect(updated).toBe(reference.serialize(reference.parse(updated)!));
    expect(paragraph).toHaveBeenCalledTimes(2);
    expect(strong).toHaveBeenCalledTimes(1);
    expect(serialize(doc)).toBe(initial);
  });
});

describe('plain Markdown parser', () => {
  const remark = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

  it('uses a JSON default document for plain content', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = createEditor(host, '# Plain\n\nParagraph text.', { onUpdate: () => {} });
    editors.push({ editor, host });
    await editor.create();
    expect(editor.action((ctx) => ctx.get(defaultValueCtx))).toMatchObject({ type: 'json' });
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    expect(view.state.doc.child(0).type.name).toBe('heading');
    expect(view.state.doc.child(0).attrs.level).toBe(1);
    expect(view.state.doc.child(1).type.name).toBe('paragraph');
    expect(view.state.doc.textContent).toBe('PlainParagraph text.');
  });

  it('keeps Markdown defaults for empty and richer content', async () => {
    for (const markdown of ['', '**bold**']) {
      const host = document.createElement('div');
      document.body.append(host);
      const editor = createEditor(host, markdown, { onUpdate: () => {} });
      editors.push({ editor, host });
      await editor.create();
      expect(editor.action((ctx) => ctx.get(defaultValueCtx))).toBe(markdown);
    }
  });

  it('matches remark for plain headings, paragraphs and blank lines', () => {
    for (const markdown of [
      '',
      '# Heading\n\nFirst paragraph.\n\nSecond\nlines\n',
      'Paragraph with one trailing space. \n\nNext paragraph.',
      'PERF_INPUT_TARGET and snake_case_names stay plain.',
      '## 中文标题\n\nPlain text with 5000 ordinary Chinese characters and English words.',
    ]) {
      expect(parseSimpleMarkdown(markdown)).toEqual(remark.parse(markdown));
    }
  });

  it('accepts the long plain performance fixture', () => {
    const markdown = readFileSync('tests/perf/fixtures/long-5000.md', 'utf8');
    expect(parseSimpleMarkdown(markdown)).toBeDefined();
  });

  it('matches the ProseMirror JSON for simple GFM tables', async () => {
    const markdown =
      '# Table\n\nBefore.\n\n| Name | Number | Notes |\n| :--- | ---: | :---: |\n| one | `two` | 中文 |\n| three | four | five |\n\nAfter.';
    const reference = await fixture(false);
    expect(createSimpleDocument(markdown)).toEqual(reference.parse(markdown)!.toJSON());
  });

  it('accepts the 1200-row performance table', () => {
    const markdown = readFileSync('tests/perf/fixtures/table-1200.md', 'utf8');
    expect(createSimpleDocument(markdown)).toBeDefined();
  });

  it('falls back for malformed or rich tables', () => {
    for (const markdown of [
      '| A | B |\n| --- | --- |',
      '| A | B |\n| --- | --- |\n| only one |',
      '| A | B |\n| --- | --- |\n| **bold** | text |',
      '| A | B |\n| --- | --- |\n| `open | text |',
      '| A | B |\n| --- | --- |\n| ``code`` | text |',
      '| A | B |\n| --- | --- |\n| https://example.com | text |',
    ]) {
      expect(createSimpleDocument(markdown)).toBeUndefined();
    }
  });

  it('falls back for richer syntax and automatic links', () => {
    for (const markdown of [
      '[link](a.md)',
      'https://example.com',
      '{{EMAIL_jy5sizcm}}',
      '- item',
      '1. item',
      '```js\nconst a = 1\n```',
      'Paragraph *emphasis*',
      'Paragraph _emphasis_',
      'Paragraph __strong__',
      '| A | B |\n| --- | --- |\n| a | b |',
      '$$x$$',
      '  indented',
      'Hard break.  \nNext line',
    ]) {
      expect(parseSimpleMarkdown(markdown)).toBeUndefined();
    }
  });
});
