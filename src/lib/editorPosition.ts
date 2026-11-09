import { editorViewCtx, remarkCtx, schemaCtx, type Editor } from '@milkdown/kit/core';
import { ParserState, type MarkdownNode, type RemarkParser } from '@milkdown/kit/transformer';
import { TextSelection, Selection } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import { mapTextOffset } from './textPosition';
import {
  mapSourceScroll,
  measureSourceText,
  measureSourceLayout,
  sourceTextLayout,
} from './sourcePosition';
import { mapImageOffset, type PendingImageReference } from './imagePaths';
import { resolveTextAnchor, textAnchor, type SessionEditorPlace } from './sessionPosition';
import type { OutlineItem } from './types';

export interface SourcePlace {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
  top: number;
  left: number;
  rewrites?: { before: string; after: string; references: PendingImageReference[] }[];
}
export interface RenderedPlace {
  selection: Selection;
  doc: PMNode;
  top: number;
  left: number;
}
export interface ModeExchange {
  markdown: string;
  source: SourcePlace;
  rendered: RenderedPlace;
}
interface Block {
  from: number;
  to: number;
  pos: number;
  node: PMNode;
  source: Ast;
}
const blockCache = new WeakMap<Editor, { doc: PMNode; markdown: string; items: Block[] }>();
const renderedBlockCache = new WeakMap<PMNode, Pick<Block, 'pos' | 'node'>[]>();
export interface Ast {
  type: string;
  value?: string;
  children?: Ast[];
  position?: MarkdownNode['position'];
}

/** Source offsets come from the same Markdown grammar and heading text as the rich editor. */
export function extractSourceOutline(editor: Editor, markdown: string, parsed: Ast): OutlineItem[] {
  return editor.action((ctx) => {
    const remark = ctx.get(remarkCtx);
    const ast = remark.runSync(parsed, markdown) as unknown as Ast;
    const headings: Ast[] = [];
    const walk = (node: Ast) => {
      if (node.type === 'heading' && node.position?.start.offset !== undefined) headings.push(node);
      else node.children?.forEach(walk);
    };
    walk(ast);
    if (!headings.length) return [];
    const doc = new ParserState(ctx.get(schemaCtx))
      .next({ type: 'root', children: headings as unknown as MarkdownNode[] })
      .toDoc();
    return headings.map((heading, index) => ({
      level: doc.child(index).attrs.level as number,
      text: doc.child(index).textContent,
      pos: heading.position!.start.offset!,
    }));
  });
}

export function sourcePlace(input: HTMLTextAreaElement): SourcePlace {
  return {
    start: input.selectionStart,
    end: input.selectionEnd,
    direction: input.selectionDirection,
    top: input.scrollTop,
    left: input.scrollLeft,
  };
}
export function restoreSource(input: HTMLTextAreaElement, place: SourcePlace, focus = false): void {
  if (focus) input.focus({ preventScroll: true });
  input.setSelectionRange(place.start, place.end, place.direction);
  input.scrollTop = place.top;
  input.scrollLeft = place.left;
  for (const rewrite of place.rewrites ?? []) {
    input.scrollTop = mapSourceScroll(input, rewrite.before, rewrite.after, (offset) =>
      mapImageOffset(rewrite.before, rewrite.references, offset),
    );
  }
}
export function rebaseSourcePlace(
  place: SourcePlace,
  before: string,
  after: string,
  references: PendingImageReference[],
): SourcePlace {
  return {
    ...place,
    start: mapImageOffset(before, references, place.start),
    end: mapImageOffset(before, references, place.end),
    rewrites: [...(place.rewrites ?? []), { before, after, references }],
  };
}
export function renderedPlace(editor: Editor): RenderedPlace {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const scroller = view.dom.closest<HTMLElement>('.milkdown-container');
    return {
      selection: view.state.selection,
      doc: view.state.doc,
      top: scroller?.scrollTop ?? 0,
      left: scroller?.scrollLeft ?? 0,
    };
  });
}
export function restoreRendered(editor: Editor, place: RenderedPlace, focus = false): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (place.doc.eq(view.state.doc) && !view.state.selection.eq(place.selection)) {
      view.dispatch(
        view.state.tr.setSelection(Selection.fromJSON(view.state.doc, place.selection.toJSON())),
      );
    }
    if (focus) view.focus();
    const scroller = view.dom.closest<HTMLElement>('.milkdown-container');
    if (scroller) {
      scroller.scrollTop = place.top;
      scroller.scrollLeft = place.left;
    }
  });
}

/** Pair positioned Markdown blocks with Milkdown textblocks in document order. */
function blocks(editor: Editor, markdown: string): Block[] {
  return editor.action((ctx) =>
    positionedBlocks(editor, markdown, ctx.get(editorViewCtx).state.doc, ctx.get(remarkCtx)),
  );
}

function renderedBlocks(doc: PMNode): Pick<Block, 'pos' | 'node'>[] {
  const cached = renderedBlockCache.get(doc);
  if (cached) return cached;
  const items: Pick<Block, 'pos' | 'node'>[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock && node.type.name !== 'math_block' && node.type.name !== 'html')
      return true;
    items.push({ pos, node });
    return false;
  });
  renderedBlockCache.set(doc, items);
  return items;
}

function positionedBlocks(
  editor: Editor,
  markdown: string,
  doc: PMNode,
  remark: RemarkParser,
): Block[] {
  const cached = blockCache.get(editor);
  if (cached?.doc === doc && cached.markdown === markdown) return cached.items;
  const ast = remark.runSync(remark.parse(markdown), markdown) as unknown as Ast;
  const sources: { from: number; to: number; kind: string; source: Ast }[] = [];
  const kinds: Record<string, string> = {
    heading: 'heading',
    paragraph: 'paragraph',
    code: 'code_block',
    tableCell: 'paragraph',
    math: 'math_block',
    html: 'html',
  };
  const walk = (node: Ast) => {
    if (
      kinds[node.type] &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined
    ) {
      sources.push({
        from: node.position.start.offset,
        to: node.position.end.offset,
        kind: kinds[node.type],
        source: node,
      });
    } else node.children?.forEach(walk);
  };
  walk(ast);
  const mapped: Block[] = [];
  let index = 0;
  for (const { node, pos } of renderedBlocks(doc)) {
    let sourceIndex = index;
    while (sourceIndex < sources.length && sources[sourceIndex].kind !== node.type.name)
      sourceIndex++;
    if (sourceIndex === sources.length) continue;
    const source = sources[sourceIndex];
    mapped.push({ from: source.from, to: source.to, pos, node, source: source.source });
    index = sourceIndex + 1;
  }
  blockCache.set(editor, { doc, markdown, items: mapped });
  return mapped;
}

function sourceBlock(items: Block[], offset: number): number {
  let found = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].from > offset) break;
    found = i;
  }
  return found;
}
function renderedBlock(items: Block[], offset: number): number {
  let found = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].pos > offset) break;
    found = i;
  }
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
  const segments: { from: number; to: number; raw: string; text: string; positions: number[] }[] =
    [];
  let cursor = 0;
  const walk = (node: Ast) => {
    if (
      typeof node.value === 'string' &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined
    ) {
      const found = text.indexOf(node.value, cursor);
      if (found < 0 || !node.value.length) return;
      const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
      const literal = raw.indexOf(node.value);
      const from = node.position.start.offset + Math.max(0, literal);
      segments.push({
        from,
        to: literal >= 0 ? from + node.value.length : node.position.end.offset,
        raw: literal >= 0 ? node.value : raw,
        text: node.value,
        positions: positions.slice(found, found + node.value.length),
      });
      cursor = found + node.value.length;
    } else node.children?.forEach(walk);
  };
  walk(block.source);
  return segments;
}
function sourceOffset(block: Block, offset: number, markdown: string, isEnd: boolean): number {
  const segments = textSegments(block, markdown);
  const segment =
    // Selection starts belong to the following text; ends stay before its closing markup.
    segments.find((item, index) => {
      const end = item.positions[item.positions.length - 1] + 1;
      // Inline nodes occupy a gap; only adjacent text can share this boundary.
      return (
        end >= offset &&
        (isEnd || end !== offset || segments[index + 1]?.positions[0] !== offset)
      );
    }) ??
    segments[segments.length - 1];
  if (!segment) return block.from;
  const index = segment.positions.findIndex((pos) => pos >= offset);
  return (
    segment.from + mapTextOffset(segment.text, segment.raw, index < 0 ? segment.text.length : index)
  );
}
function renderedOffset(block: Block, offset: number, markdown: string): number {
  const segments = textSegments(block, markdown);
  const segment = segments.find((item) => item.to >= offset) ?? segments[segments.length - 1];
  if (!segment) return block.pos + (block.node.isTextblock ? 1 : 0);
  const index = mapTextOffset(
    segment.raw,
    segment.text,
    Math.max(0, Math.min(segment.raw.length, offset - segment.from)),
  );
  return segment.positions[index] ?? segment.positions[segment.positions.length - 1] + 1;
}

/** Measure the actual wrapped source text; a document-wide scroll percentage is not a content anchor. */
function sourceRect(block: Block, y: (offset: number) => number, lineHeight: number) {
  const top = y(block.from);
  return {
    top,
    height: Math.max(lineHeight, y(Math.max(block.from, block.to - 1)) - top + lineHeight),
  };
}
function renderedRects(view: EditorView, items: Pick<Block, 'pos'>[]) {
  const scroller = view.dom.closest<HTMLElement>('.milkdown-container')!;
  const origin = scroller.getBoundingClientRect().top;
  const scale = scroller.clientHeight
    ? scroller.getBoundingClientRect().height / scroller.clientHeight
    : 1;
  return items.map((block) => {
    const dom = view.nodeDOM(block.pos) as HTMLElement | null;
    const rect = dom?.getBoundingClientRect();
    return {
      top: rect ? (rect.top - origin) / scale + scroller.scrollTop : 0,
      height: rect ? rect.height / scale : 1,
    };
  });
}
function visibleRenderedBlock(view: EditorView, items: Pick<Block, 'pos'>[], top: number) {
  const measured = new Map<number, { top: number; height: number }>();
  const rect = (index: number) => {
    let value = measured.get(index);
    if (!value) {
      value = renderedRects(view, [items[index]])[0];
      measured.set(index, value);
    }
    return value;
  };
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rect(middle).top <= top) low = middle + 1;
    else high = middle;
  }
  let index = Math.max(0, low - 1);
  const rowTop = rect(index).top;
  // Table cells share a row top but can have different text heights.
  while (index > 0 && Math.abs(rect(index - 1).top - rowTop) < 0.5) index--;
  while (index < items.length - 1 && rect(index).top + rect(index).height <= top) index++;
  return { index, rect: rect(index) };
}
function transferTop(
  from: { top: number; height: number },
  to: { top: number; height: number },
  top: number,
): number {
  const offset = top - from.top;
  return to.top + (offset < 0 ? offset : (offset / Math.max(1, from.height)) * to.height);
}

/** Serialize source selection and its first visible text line, rather than a body snapshot. */
export function sourceSessionPlace(
  input: HTMLTextAreaElement,
  markdown = input.value,
): SessionEditorPlace {
  return captureSourceSessionPlace(input, markdown)();
}

/** Capture only selection and metrics now; build the full text mirror during persistence. */
export function captureSourceSessionPlace(
  input: HTMLTextAreaElement,
  markdown: string,
): () => SessionEditorPlace {
  const place = sourcePlace(input);
  const layout = input.clientWidth && place.top > 0 ? sourceTextLayout(input) : null;
  return () => {
    const saved: SessionEditorPlace = {
      sourceMode: true,
      start: textAnchor(markdown, place.start),
      end: textAnchor(markdown, place.end),
      direction: place.direction,
      top: place.top,
      left: place.left,
    };
    if (layout) {
      saved.scroll = measureSourceLayout(layout, markdown, (top) => {
        let low = 0;
        let high = markdown.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (top(middle) < place.top) low = middle + 1;
          else high = middle;
        }
        return { anchor: textAnchor(markdown, low), gap: top(low) - place.top };
      });
    }
    return saved;
  };
}

/** Convert PM positions into Markdown anchors; PM Node/Selection never enter settings. */
export function renderedSessionPlace(editor: Editor, markdown: string): SessionEditorPlace {
  return captureRenderedSessionPlace(editor, markdown)();
}

/** Freeze document, selection and visible geometry before another tab can change the view. */
export function captureRenderedSessionPlace(
  editor: Editor,
  markdown: string,
): () => SessionEditorPlace {
  const place = renderedPlace(editor);
  const remark = editor.action((ctx) => ctx.get(remarkCtx));
  const candidates = place.top > 0 ? renderedBlocks(place.doc) : [];
  const visible = candidates.length
    ? editor.action((ctx) => {
        const item = visibleRenderedBlock(ctx.get(editorViewCtx), candidates, place.top);
        return { pos: candidates[item.index].pos, rect: item.rect };
      })
    : undefined;
  return () =>
    renderedSessionAnchors(
      place,
      markdown,
      positionedBlocks(editor, markdown, place.doc, remark),
      visible,
    );
}

function renderedSessionAnchors(
  place: RenderedPlace,
  markdown: string,
  items: Block[],
  visible?: { pos: number; rect: { top: number; height: number } },
): SessionEditorPlace {
  const offset = (at: number) =>
    items.length
      ? sourceOffset(items[renderedBlock(items, at)], at, markdown, at === place.selection.to)
      : 0;
  const anchor = offset(place.selection.anchor);
  // shortcut: persist a caret for disjoint selections, add range anchors if session multi-selection restore is needed.
  const head = place.selection.ranges.length > 1 ? anchor : offset(place.selection.head);
  const saved: SessionEditorPlace = {
    sourceMode: false,
    start: textAnchor(markdown, Math.min(anchor, head)),
    end: textAnchor(markdown, Math.max(anchor, head)),
    direction: anchor > head ? 'backward' : 'forward',
    top: place.top,
    left: place.left,
  };
  if (items.length && visible) {
    const { rect } = visible;
    saved.scroll = {
      anchor: textAnchor(markdown, items[renderedBlock(items, visible.pos)].from),
      gap: rect.top - place.top,
    };
    if (place.top >= rect.top)
      saved.scroll.fraction = Math.min(1, (place.top - rect.top) / Math.max(1, rect.height));
  }
  return saved;
}

export function restoreSessionSource(input: HTMLTextAreaElement, saved: SessionEditorPlace): void {
  const markdown = input.value;
  let top = saved.top;
  if (saved.scroll && input.clientWidth)
    top = measureSourceText(input, markdown, (at) =>
      Math.max(0, at(resolveTextAnchor(markdown, saved.scroll!.anchor)) - saved.scroll!.gap),
    );
  const start = resolveTextAnchor(markdown, saved.start);
  const end = resolveTextAnchor(markdown, saved.end);
  restoreSource(input, {
    start: Math.min(start, end),
    end: Math.max(start, end),
    direction: saved.direction,
    top,
    left: saved.left,
  });
}

export function restoreSessionRendered(
  editor: Editor,
  markdown: string,
  saved: SessionEditorPlace,
): void {
  const items = blocks(editor, markdown);
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const offset = (anchor: SessionEditorPlace['start']) => {
      const at = resolveTextAnchor(markdown, anchor);
      return items.length ? renderedOffset(items[sourceBlock(items, at)], at, markdown) : 0;
    };
    const start = Math.max(0, Math.min(view.state.doc.content.size, offset(saved.start)));
    const end = Math.max(0, Math.min(view.state.doc.content.size, offset(saved.end)));
    const selection = TextSelection.between(
      view.state.doc.resolve(saved.direction === 'backward' ? end : start),
      view.state.doc.resolve(saved.direction === 'backward' ? start : end),
    );
    if (!view.state.selection.eq(selection)) view.dispatch(view.state.tr.setSelection(selection));
    const scroller = view.dom.closest<HTMLElement>('.milkdown-container');
    if (!scroller) return;
    let top = saved.top;
    if (saved.scroll && items.length) {
      const at = sourceBlock(items, resolveTextAnchor(markdown, saved.scroll.anchor));
      const rect = renderedRects(view, [items[at]])[0];
      top =
        rect.top +
        (saved.scroll.fraction === undefined
          ? -saved.scroll.gap
          : saved.scroll.fraction * rect.height);
    }
    scroller.scrollTop = Math.max(0, top);
    scroller.scrollLeft = saved.left;
  });
}

export function toSource(
  editor: Editor,
  markdown: string,
  input: HTMLTextAreaElement,
  exchange?: ModeExchange,
): void {
  const current = renderedPlace(editor);
  if (
    exchange?.markdown === markdown &&
    current.doc.eq(exchange.rendered.doc) &&
    current.selection.eq(exchange.rendered.selection) &&
    Math.abs(current.top - exchange.rendered.top) < 2
  ) {
    restoreSource(input, exchange.source, true);
    return;
  }
  const items = blocks(editor, markdown);
  if (!items.length) {
    restoreSource(input, { start: 0, end: 0, direction: 'none', top: 0, left: 0 }, true);
    return;
  }
  const rendered = editor.action((ctx) =>
    visibleRenderedBlock(ctx.get(editorViewCtx), items, current.top),
  );
  const at = rendered.index;
  const top = measureSourceText(input, input.value, (y, lineHeight) =>
    transferTop(rendered.rect, sourceRect(items[at], y, lineHeight), current.top),
  );
  const anchor = sourceOffset(
    items[renderedBlock(items, current.selection.anchor)],
    current.selection.anchor,
    markdown,
    current.selection.anchor >= current.selection.head,
  );
  const head = sourceOffset(
    items[renderedBlock(items, current.selection.head)],
    current.selection.head,
    markdown,
    current.selection.head >= current.selection.anchor,
  );
  restoreSource(
    input,
    {
      start: Math.min(anchor, head),
      end: Math.max(anchor, head),
      direction: anchor > head ? 'backward' : 'forward',
      top,
      left: 0,
    },
    true,
  );
}

export function toRendered(
  editor: Editor,
  markdown: string,
  input: HTMLTextAreaElement,
  exchange?: ModeExchange,
): void {
  const current = sourcePlace(input);
  if (
    exchange?.markdown === markdown &&
    current.start === exchange.source.start &&
    current.end === exchange.source.end &&
    Math.abs(current.top - exchange.source.top) < 2
  ) {
    restoreRendered(editor, exchange.rendered, true);
    return;
  }
  const items = blocks(editor, markdown);
  if (!items.length) return;
  // Source block ends are ordered; locate the visible block without measuring the whole document.
  const source = measureSourceText(input, input.value, (y, lineHeight) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const rect = sourceRect(items[middle], y, lineHeight);
      if (rect.top + rect.height > current.top) high = middle;
      else low = middle + 1;
    }
    const index = Math.min(low, items.length - 1);
    return { index, rect: sourceRect(items[index], y, lineHeight) };
  });
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const rendered = renderedRects(view, [items[source.index]])[0];
    const start = renderedOffset(items[sourceBlock(items, current.start)], current.start, markdown);
    const end = renderedOffset(items[sourceBlock(items, current.end)], current.end, markdown);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.between(
          view.state.doc.resolve(current.direction === 'backward' ? end : start),
          view.state.doc.resolve(current.direction === 'backward' ? start : end),
        ),
      ),
    );
    view.focus();
    const scroller = view.dom.closest<HTMLElement>('.milkdown-container')!;
    scroller.scrollTop = transferTop(source.rect, rendered, current.top);
  });
}
