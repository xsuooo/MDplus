import type { Ctx } from '@milkdown/kit/ctx';
import { remarkCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import {
  bulletListSchema,
  docSchema,
  imageSchema,
  orderedListSchema,
} from '@milkdown/kit/preset/commonmark';
import {
  extendListItemSchemaForTask as listItemSchema,
  remarkGFMPlugin,
  tableHeaderRowSchema,
  tableRowSchema,
} from '@milkdown/kit/preset/gfm';
import { SerializerState, type MarkdownNode, type JSONRecord } from '@milkdown/kit/transformer';
import { $node } from '@milkdown/kit/utils';
import type { Node } from '@milkdown/prose/model';
import { defaultHandlers } from 'mdast-util-to-markdown';
import { gfmTableToMarkdown } from 'mdast-util-gfm-table';
import type { Root, RootContent } from 'mdast';
import type { Point } from 'unist';
import { createNodeIndex } from './documentNodes';

const imageNodes = createNodeIndex('image');

interface SourceLine {
  value: string;
  start: number;
  end: number;
  number: number;
}

const point = (line: number, column: number, offset: number): Point => ({ line, column, offset });
const linePosition = (first: SourceLine, last: SourceLine) => ({
  start: point(first.number, 1, first.start),
  end: point(last.number, last.end - last.start + 1, last.end),
});
const inlinePosition = (first: SourceLine, last: SourceLine) => ({
  start: point(first.number, 1, first.start),
  end: point(last.number, last.value.length + 1, last.start + last.value.length),
});
const simpleInline = /[\\`*{}[\]<>|&$~#]/;
const unsafeUnderscore = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/u;
const simpleBlock = /^(?:[-+=>]|\d+[.)]\s)/;
const automaticLink = /(?:https?:\/\/|www\.|@)/i;

/** Parse only plain headings and paragraphs; every richer construct uses micromark. */
export function parseSimpleMarkdown(markdown: string): Root | undefined {
  if (markdown.includes('\r')) return undefined;
  let offset = 0;
  const lines = markdown.split('\n').map((raw, index) => {
    const value = raw.endsWith(' ') && !raw.endsWith('  ') ? raw.slice(0, -1) : raw;
    const line = { value, start: offset, end: offset + raw.length, number: index + 1 };
    offset += raw.length + 1;
    return line;
  });
  const children: RootContent[] = [];
  let paragraph: SourceLine[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const first = paragraph[0];
    const last = paragraph[paragraph.length - 1];
    const position = linePosition(first, last);
    children.push({
      type: 'paragraph',
      children: [
        {
          type: 'text',
          value: paragraph.map((line) => line.value).join('\n'),
          position: inlinePosition(first, last),
        },
      ],
      position,
    });
    paragraph = [];
  };

  for (const line of lines) {
    if (!line.value) {
      flushParagraph();
      continue;
    }
    if (line.value !== line.value.trim()) return undefined;
    const heading = /^(#{1,6})[ \t]+(.+)$/.exec(line.value);
    if (heading) {
      if (
        simpleInline.test(heading[2]) ||
        unsafeUnderscore.test(heading[2]) ||
        automaticLink.test(heading[2])
      )
        return undefined;
      flushParagraph();
      const contentStart = line.start + line.value.length - heading[2].length;
      const position = linePosition(line, line);
      children.push({
        type: 'heading',
        depth: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: [
          {
            type: 'text',
            value: heading[2],
            position: {
              start: point(line.number, contentStart - line.start + 1, contentStart),
              end: point(line.number, line.value.length + 1, line.start + line.value.length),
            },
          },
        ],
        position,
      });
    } else {
      if (
        simpleInline.test(line.value) ||
        unsafeUnderscore.test(line.value) ||
        simpleBlock.test(line.value) ||
        automaticLink.test(line.value)
      )
        return undefined;
      paragraph.push(line);
    }
  }
  flushParagraph();
  const last = lines[lines.length - 1];
  return {
    type: 'root',
    children,
    position: {
      start: point(1, 1, 0),
      end: point(last.number, last.end - last.start + 1, markdown.length),
    },
  };
}

interface DocumentJSON extends JSONRecord {
  type: string;
  content: JSONRecord[];
}

function documentFromRoot(root: Root): DocumentJSON {
  const content: JSONRecord[] = [];
  for (const node of root.children) {
    if (node.type !== 'heading' && node.type !== 'paragraph')
      throw new Error('unsupported plain node');
    const text = node.children[0];
    if (text?.type !== 'text') throw new Error('unsupported plain inline');
    content.push(
      node.type === 'heading'
        ? {
            type: 'heading',
            attrs: { id: '', level: node.depth },
            content: [{ type: 'text', text: text.value }],
          }
        : { type: 'paragraph', content: [{ type: 'text', text: text.value }] },
    );
  }
  return { type: 'doc', content };
}

function tableRowParts(value: string): string[] | undefined {
  if (!value.startsWith('|') || !value.endsWith('|')) return undefined;
  return value
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

type Alignment = 'left' | 'center' | 'right';
function tableAlignments(value: string): Alignment[] | undefined {
  const cells = tableRowParts(value);
  if (!cells) return undefined;
  const alignments: Alignment[] = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return undefined;
    alignments.push(
      cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left',
    );
  }
  return alignments;
}

function tableInline(text: string): JSONRecord[] | undefined {
  const parts = text.split('`');
  if (parts.length % 2 === 0) return undefined;
  const content: JSONRecord[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const plain = parts[index];
    if (simpleInline.test(plain) || unsafeUnderscore.test(plain) || automaticLink.test(plain))
      return undefined;
    if (plain) content.push({ type: 'text', text: plain });
    if (index + 1 < parts.length) {
      const code = parts[index + 1];
      if (!code) return undefined;
      content.push({ type: 'text', text: code, marks: [{ type: 'inlineCode' }] });
    }
  }
  return content;
}

function tableRow(
  type: 'table_header_row' | 'table_row',
  cells: string[],
  alignments: Alignment[],
): JSONRecord | undefined {
  const content: JSONRecord[] = [];
  for (let index = 0; index < cells.length; index++) {
    const inline = tableInline(cells[index]);
    if (!inline) return undefined;
    content.push({
      type: type === 'table_header_row' ? 'table_header' : 'table_cell',
      attrs: { alignment: alignments[index], colspan: 1, rowspan: 1, colwidth: null },
      content: [{ type: 'paragraph', ...(inline.length ? { content: inline } : {}) }],
    });
  }
  return { type, content };
}

function createSimpleTableDocument(markdown: string): DocumentJSON | undefined {
  if (markdown.includes('\r')) return undefined;
  const rawLines = markdown.split('\n');
  const lines = rawLines.map((raw) =>
    raw.endsWith(' ') && !raw.endsWith('  ') ? raw.slice(0, -1) : raw,
  );
  const content: JSONRecord[] = [];
  let textLines: string[] = [];
  let sawTable = false;
  const flushText = () => {
    if (!textLines.length) return true;
    const root = parseSimpleMarkdown(textLines.join('\n'));
    textLines = [];
    if (!root) return false;
    content.push(...documentFromRoot(root).content);
    return true;
  };

  for (let index = 0; index < lines.length;) {
    const header = tableRowParts(lines[index]);
    const alignments = index + 1 < lines.length ? tableAlignments(lines[index + 1]) : undefined;
    if (!header || !alignments || header.length !== alignments.length) {
      textLines.push(rawLines[index]);
      index += 1;
      continue;
    }
    if (!flushText()) return undefined;
    const headerRow = tableRow('table_header_row', header, alignments);
    if (!headerRow) return undefined;
    const rows: JSONRecord[] = [];
    index += 2;
    while (index < lines.length) {
      const cells = tableRowParts(lines[index]);
      if (!cells) break;
      if (cells.length !== header.length) return undefined;
      const row = tableRow('table_row', cells, alignments);
      if (!row) return undefined;
      rows.push(row);
      index += 1;
    }
    if (!rows.length) return undefined;
    content.push({ type: 'table', content: [headerRow, ...rows] });
    sawTable = true;
  }
  if (!sawTable || !flushText()) return undefined;
  return { type: 'doc', content };
}

export function createSimpleDocument(markdown: string): JSONRecord | undefined {
  const tableDocument = markdown.includes('|') ? createSimpleTableDocument(markdown) : undefined;
  if (tableDocument) return tableDocument;
  const root = parseSimpleMarkdown(markdown);
  if (!root?.children.length) return undefined;
  return documentFromRoot(root);
}

export function cacheMarkdownParser(ctx: Ctx): () => void {
  const remark = ctx.get(remarkCtx);
  const parse = remark.parse.bind(remark);
  let previous: { text: string; tree: ReturnType<typeof parse> } | undefined;
  remark.parse = (input) => {
    if (typeof input !== 'string') return parse(input);
    if (previous?.text === input) return structuredClone(previous.tree);
    const tree = parseSimpleMarkdown(input) ?? parse(input);
    // Remark plugins mutate their input; retain the raw parse and return independent trees.
    previous = { text: input, tree: structuredClone(tree) };
    return tree;
  };
  return () => {
    remark.parse = parse;
  };
}

export const cachedDocSchema = $node('doc', () => {
  const cache = new WeakMap<Node, MarkdownNode[] | null>();
  return {
    ...docSchema.schema,
    toMarkdown: {
      ...docSchema.schema.toMarkdown,
      runner: (state, node) => {
        state.openNode('root');
        node.forEach((block) => {
          // shortcut: cache only top-level text blocks/tables without images, extend after validating context and URL invalidation.
          if (!['paragraph', 'heading', 'table'].includes(block.type.name) || block.marks.length) {
            state.next(block);
            return;
          }
          let nodes = cache.get(block);
          if (nodes === undefined) {
            nodes = imageNodes(block).length
              ? null
              : (new SerializerState(state.schema).openNode('root').next(block).build().children ??
                []);
            cache.set(block, nodes);
          }
          if (nodes) nodes.forEach((item) => state.top()?.push(item));
          else state.next(block);
        });
      },
    },
  };
});

/** Normalize Markdown/DOM attributes to the strict Milkdown schema types. */
export function configureMarkdownSchemas(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, (options) => {
    const cache = new WeakMap<object, string>();
    const cells = new WeakMap<object, string>();
    const paragraph = options.handlers?.paragraph ?? defaultHandlers.paragraph;
    const table =
      options.handlers?.table ??
      gfmTableToMarkdown(ctx.get(remarkGFMPlugin.options.key)).handlers!.table!;
    const handlers: typeof options.handlers = {
      ...options.handlers,
      paragraph: (node, parent, state, info) => {
        if (
          parent?.type !== 'root' ||
          info.lineShift !== 0 ||
          info.now.column !== 1 ||
          info.before !== '\n' ||
          info.after !== '\n'
        )
          return paragraph(node, parent, state, info);
        const previous = cache.get(node);
        if (previous !== undefined) return previous;
        const value = paragraph(node, parent, state, info);
        cache.set(node, value);
        return value;
      },
      table: (node, parent, state, info) => {
        if (parent?.type !== 'root' || info.lineShift !== 0 || info.now.column !== 1)
          return table(node, parent, state, info);
        const previous = cache.get(node);
        if (previous !== undefined) return previous;
        // GFM still computes widths for the whole table; unchanged cells reuse their escaped text.
        const phrasing = state.containerPhrasing;
        state.containerPhrasing = (cell, cellInfo) => {
          if (cell.type !== 'tableCell') return phrasing.call(state, cell, cellInfo);
          const previous = cells.get(cell);
          if (previous !== undefined) return previous;
          const value = phrasing.call(state, cell, cellInfo);
          cells.set(cell, value);
          return value;
        };
        try {
          const value = table(node, parent, state, info);
          cache.set(node, value);
          return value;
        } finally {
          state.containerPhrasing = phrasing;
        }
      },
    };
    return { ...options, handlers };
  });
  for (const rowSchema of [tableHeaderRowSchema, tableRowSchema]) {
    ctx.update(rowSchema.key, (original) => (ctx) => {
      const schema = original(ctx);
      const rows = new WeakMap<Node, MarkdownNode[] | null>();
      return {
        ...schema,
        toMarkdown: {
          ...schema.toMarkdown,
          runner: (state, row) => {
            if (row.marks.length) return schema.toMarkdown.runner(state, row);
            let nodes = rows.get(row);
            if (nodes === undefined) {
              if (imageNodes(row).length) nodes = null;
              else {
                const isolated = new SerializerState(state.schema).openNode('root');
                schema.toMarkdown.runner(isolated, row);
                nodes = isolated.build().children ?? [];
              }
              rows.set(row, nodes);
            }
            if (nodes) nodes.forEach((node) => state.top()?.push(node));
            else schema.toMarkdown.runner(state, row);
          },
        },
      };
    });
  }
  ctx.update(imageSchema.key, (original) => (ctx) => {
    const schema = original(ctx);
    return {
      ...schema,
      parseDOM: [
        {
          tag: 'img[src]',
          getAttrs: (dom) => ({
            src: dom.getAttribute('src') ?? '',
            alt: dom.getAttribute('alt') ?? '',
            title: dom.getAttribute('title') ?? '',
          }),
        },
      ],
      parseMarkdown: {
        ...schema.parseMarkdown,
        runner: (state, node, type) => {
          // Remark uses null for an absent title; Milkdown 7.21.3 requires a string.
          schema.parseMarkdown.runner(
            state,
            { ...node, alt: node.alt ?? '', title: node.title ?? '' },
            type,
          );
        },
      },
    };
  });

  // The bundled list parsers stringify spread although their schemas require booleans.
  for (const listSchema of [bulletListSchema, orderedListSchema, listItemSchema]) {
    ctx.update(listSchema.key, (original) => (ctx) => {
      const schema = original(ctx);
      return {
        ...schema,
        parseDOM: schema.parseDOM?.map((rule) => {
          if (!('tag' in rule) || !rule.getAttrs) return rule;
          const getAttrs = rule.getAttrs;
          return {
            ...rule,
            getAttrs: (dom: HTMLElement) => {
              const attrs = getAttrs(dom);
              if (!attrs) return attrs;
              return {
                ...attrs,
                ...(listSchema === listItemSchema
                  ? {
                      label: attrs.label ?? '\u2022',
                      listType: attrs.listType ?? 'bullet',
                    }
                  : {}),
                spread: attrs.spread === true || attrs.spread === 'true',
              };
            },
          };
        }),
        parseMarkdown: {
          ...schema.parseMarkdown,
          runner: (state, node, type) => {
            const spread = node.spread === true;
            if (listSchema === listItemSchema) {
              state.openNode(type, {
                label: node.label != null ? `${node.label}.` : '\u2022',
                listType: node.label != null ? 'ordered' : 'bullet',
                spread,
                checked: node.checked ?? null,
              });
            } else {
              state.openNode(type, { spread, ...(node.ordered ? { order: node.start ?? 1 } : {}) });
            }
            state.next(node.children).closeNode();
          },
        },
        toMarkdown: {
          ...schema.toMarkdown,
          runner: (state, node) => {
            if (listSchema === listItemSchema) {
              state.openNode('listItem', undefined, {
                spread: node.attrs.spread,
                ...(node.attrs.checked != null ? { checked: node.attrs.checked } : {}),
              });
            } else {
              const ordered = listSchema === orderedListSchema;
              state.openNode('list', undefined, {
                ordered,
                spread: node.attrs.spread,
                ...(ordered ? { start: node.attrs.order } : {}),
              });
            }
            state.next(node.content).closeNode();
          },
        },
      };
    });
  }
}
