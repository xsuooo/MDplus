import { editorViewCtx, remarkCtx, type Editor } from '@milkdown/kit/core';
import { TextSelection, Selection } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import { mapTextOffset } from './textPosition';
import { mapSourceScroll, measureSourceText } from './sourcePosition';
import { mapImageOffset, type PendingImageReference } from './imagePaths';

export interface SourcePlace {
  start: number; end: number; direction: 'forward' | 'backward' | 'none'; top: number; left: number;
  rewrites?: { before: string; after: string; references: PendingImageReference[] }[];
}
export interface RenderedPlace {
  selection: Selection; doc: PMNode; top: number; left: number;
}
export interface ModeExchange { markdown: string; source: SourcePlace; rendered: RenderedPlace }
interface Block { from: number; to: number; pos: number; node: PMNode; source: Ast }
interface Ast {
  type: string; value?: string; children?: Ast[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export function sourcePlace(input: HTMLTextAreaElement): SourcePlace {
  return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection,
    top: input.scrollTop, left: input.scrollLeft };
}
export function restoreSource(input: HTMLTextAreaElement, place: SourcePlace, focus = false): void {
  if (focus) input.focus({ preventScroll: true });
  input.setSelectionRange(place.start, place.end, place.direction);
  input.scrollTop = place.top; input.scrollLeft = place.left;
  for (const rewrite of place.rewrites ?? []) {
    input.scrollTop = mapSourceScroll(input, rewrite.before, rewrite.after,
      (offset) => mapImageOffset(rewrite.before, rewrite.references, offset));
  }
}
export function rebaseSourcePlace(place: SourcePlace, before: string, after: string, references: PendingImageReference[]): SourcePlace {
  return { ...place, start: mapImageOffset(before, references, place.start), end: mapImageOffset(before, references, place.end),
    rewrites: [...(place.rewrites ?? []), { before, after, references }] };
}
export function renderedPlace(editor: Editor): RenderedPlace {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const scroller = view.dom.closest<HTMLElement>('.milkdown-container');
    return { selection: view.state.selection, doc: view.state.doc, top: scroller?.scrollTop ?? 0, left: scroller?.scrollLeft ?? 0 };
  });
}
export function restoreRendered(editor: Editor, place: RenderedPlace, focus = false): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (place.doc.eq(view.state.doc) && !view.state.selection.eq(place.selection)) {
      view.dispatch(view.state.tr.setSelection(Selection.fromJSON(view.state.doc, place.selection.toJSON())));
    }
    if (focus) view.focus();
    const scroller = view.dom.closest<HTMLElement>('.milkdown-container');
    if (scroller) { scroller.scrollTop = place.top; scroller.scrollLeft = place.left; }
  });
}

/** Pair positioned Markdown blocks with Milkdown textblocks in document order. */
function blocks(editor: Editor, markdown: string): Block[] {
  return editor.action((ctx) => {
    const remark = ctx.get(remarkCtx);
    const ast = remark.runSync(remark.parse(markdown), markdown) as unknown as Ast;
    const sources: { from: number; to: number; kind: string; source: Ast }[] = [];
    const walk = (node: Ast) => {
      const kinds: Record<string, string> = { heading: 'heading', paragraph: 'paragraph', code: 'code_block',
        tableCell: 'paragraph', math: 'math_block', html: 'html' };
      if (kinds[node.type] && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
        sources.push({ from: node.position.start.offset, to: node.position.end.offset, kind: kinds[node.type], source: node });
      } else node.children?.forEach(walk);
    };
    walk(ast);
    const mapped: Block[] = [];
    let index = 0;
    ctx.get(editorViewCtx).state.doc.descendants((node, pos) => {
      if (!node.isTextblock && node.type.name !== 'math_block' && node.type.name !== 'html') return true;
      const sourceIndex = sources.findIndex((source, at) => at >= index && source.kind === node.type.name);
      if (sourceIndex < 0) return false;
      const source = sources[sourceIndex];
      mapped.push({ from: source.from, to: source.to, pos, node, source: source.source });
      index = sourceIndex + 1;
      return false;
    });
    return mapped;
  });
}

function sourceBlock(items: Block[], offset: number): number {
  let found = 0;
  for (let i = 0; i < items.length; i++) { if (items[i].from > offset) break; found = i; }
  return found;
}
function renderedBlock(items: Block[], offset: number): number {
  let found = 0;
  for (let i = 0; i < items.length; i++) { if (items[i].pos > offset) break; found = i; }
  return found;
}
function textSegments(block: Block, markdown: string) {
  let text = '';
  const positions: number[] = [];
  block.node.descendants((node, pos) => {
    if (!node.isText) return;
    for (let i = 0; i < node.text!.length; i++) positions.push(block.pos + 1 + pos + i);
    text += node.text;
  });
  const segments: { from: number; to: number; raw: string; text: string; positions: number[] }[] = [];
  let cursor = 0;
  const walk = (node: Ast) => {
    if (typeof node.value === 'string' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      const found = text.indexOf(node.value, cursor);
      if (found < 0 || !node.value.length) return;
      const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
      const literal = raw.indexOf(node.value);
      const from = node.position.start.offset + Math.max(0, literal);
      segments.push({ from, to: literal >= 0 ? from + node.value.length : node.position.end.offset,
        raw: literal >= 0 ? node.value : raw, text: node.value, positions: positions.slice(found, found + node.value.length) });
      cursor = found + node.value.length;
    } else node.children?.forEach(walk);
  };
  walk(block.source);
  return segments;
}
function sourceOffset(block: Block, offset: number, markdown: string): number {
  const segments = textSegments(block, markdown);
  const segment = segments.find((item) => item.positions[item.positions.length - 1] + 1 >= offset) ?? segments[segments.length - 1];
  if (!segment) return block.from;
  const index = segment.positions.findIndex((pos) => pos >= offset);
  return segment.from + mapTextOffset(segment.text, segment.raw, index < 0 ? segment.text.length : index);
}
function renderedOffset(block: Block, offset: number, markdown: string): number {
  const segments = textSegments(block, markdown);
  const segment = segments.find((item) => item.to >= offset) ?? segments[segments.length - 1];
  if (!segment) return block.pos + (block.node.isTextblock ? 1 : 0);
  const index = mapTextOffset(segment.raw, segment.text, Math.max(0, Math.min(segment.raw.length, offset - segment.from)));
  return segment.positions[index] ?? segment.positions[segment.positions.length - 1] + 1;
}

/** Measure the actual wrapped source text; a document-wide scroll percentage is not a content anchor. */
function measureSource(input: HTMLTextAreaElement, items: Block[]) {
  return measureSourceText(input, input.value, (y, lineHeight) =>
    items.map((block) => ({ top: y(block.from), height: Math.max(lineHeight, y(Math.max(block.from, block.to - 1)) - y(block.from) + lineHeight) })));
}
function renderedRects(view: EditorView, items: Block[]) {
  const scroller = view.dom.closest<HTMLElement>('.milkdown-container')!;
  const origin = scroller.getBoundingClientRect().top;
  const scale = scroller.clientHeight ? scroller.getBoundingClientRect().height / scroller.clientHeight : 1;
  return items.map((block) => {
    const dom = view.nodeDOM(block.pos) as HTMLElement | null;
    const rect = dom?.getBoundingClientRect();
    return { top: rect ? (rect.top - origin) / scale + scroller.scrollTop : 0, height: rect ? rect.height / scale : 1 };
  });
}
function transferTop(from: { top: number; height: number }[], to: { top: number; height: number }[], top: number): number {
  let index = from.findIndex((rect) => rect.top + rect.height > top);
  if (index < 0) index = from.length - 1;
  if (index < 0 || !to[index]) return 0;
  const offset = top - from[index].top;
  return to[index].top + (offset < 0 ? offset : offset / Math.max(1, from[index].height) * to[index].height);
}

export function toSource(editor: Editor, markdown: string, input: HTMLTextAreaElement, exchange?: ModeExchange): void {
  const current = renderedPlace(editor);
  if (exchange?.markdown === markdown && current.doc.eq(exchange.rendered.doc)
    && current.selection.eq(exchange.rendered.selection) && Math.abs(current.top - exchange.rendered.top) < 2) {
    restoreSource(input, exchange.source, true); return;
  }
  const items = blocks(editor, markdown);
  if (!items.length) { restoreSource(input, { start: 0, end: 0, direction: 'none', top: 0, left: 0 }, true); return; }
  const source = measureSource(input, items);
  const rendered = editor.action((ctx) => renderedRects(ctx.get(editorViewCtx), items));
  const anchor = sourceOffset(items[renderedBlock(items, current.selection.anchor)], current.selection.anchor, markdown);
  const head = sourceOffset(items[renderedBlock(items, current.selection.head)], current.selection.head, markdown);
  restoreSource(input, { start: Math.min(anchor, head), end: Math.max(anchor, head), direction: anchor > head ? 'backward' : 'forward',
    top: transferTop(rendered, source, current.top), left: 0 }, true);
}

export function toRendered(editor: Editor, markdown: string, input: HTMLTextAreaElement, exchange?: ModeExchange): void {
  const current = sourcePlace(input);
  if (exchange?.markdown === markdown && current.start === exchange.source.start && current.end === exchange.source.end
    && Math.abs(current.top - exchange.source.top) < 2) {
    restoreRendered(editor, exchange.rendered, true); return;
  }
  const items = blocks(editor, markdown);
  if (!items.length) return;
  const source = measureSource(input, items);
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const rendered = renderedRects(view, items);
    const start = renderedOffset(items[sourceBlock(items, current.start)], current.start, markdown);
    const end = renderedOffset(items[sourceBlock(items, current.end)], current.end, markdown);
    view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(current.direction === 'backward' ? end : start),
      view.state.doc.resolve(current.direction === 'backward' ? start : end))));
    view.focus();
    const scroller = view.dom.closest<HTMLElement>('.milkdown-container')!;
    scroller.scrollTop = transferTop(source, rendered, current.top);
  });
}
