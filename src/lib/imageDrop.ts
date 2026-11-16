import { errorMessage } from './errors';
import { basename } from './fileOps';
import { cancelImageInsertion, importDroppedImage, settleImageInsertion } from './imageOps';
import { protectPastedImage } from './recovery';
import {
  mapSourceEditOffset,
  subscribeSourceEditorChanges,
  type SourceEditorApi,
  type SourceTextEdit,
} from './sourceEditorApi';
import { mapTextOffset } from './textPosition';

export interface DropPosition {
  x: number;
  y: number;
}

export type ImageDropReason =
  'no-document' | 'outside-editor' | 'target-closed' | 'editor-unavailable' | 'target-changed';

export interface ImageDropFailure {
  path: string;
  message: string;
}

export interface ImageDropResult {
  attempted: number;
  inserted: number;
  failures: ImageDropFailure[];
  reason?: ImageDropReason;
}

export interface ImageDropProgress {
  completed: number;
  total: number;
}

export function isDroppedImagePath(path: string): boolean {
  return /\.(png|jpe?g)$/i.test(path);
}

/** Stable natural ordering is by filename, so 1, 2 and 10 insert in that order
 * even when Explorer supplies a different drag order or different directories. */
export function sortDroppedImages(paths: readonly string[]): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return paths
    .map((path, order) => ({ path, order, name: basename(path) }))
    .sort((a, b) => collator.compare(a.name, b.name) || a.order - b.order)
    .map(({ path }) => path);
}

/** Tauri reports physical WebView coordinates. DOM hit-testing uses CSS pixels;
 * WebView/OS scaling is already included in devicePixelRatio, while app CSS zoom
 * is handled separately by each actual editor's measured rectangles. */
export function physicalToClientPosition(
  physical: DropPosition,
  pixelRatio = window.devicePixelRatio,
): DropPosition | null {
  if (!Number.isFinite(physical.x) || !Number.isFinite(physical.y)) return null;
  const scale = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return { x: physical.x / scale, y: physical.y / scale };
}

export function containsDropPosition(element: HTMLElement, point: DropPosition): boolean {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

/** Hit-test the textarea's actual wrapped text. Measuring a mirrored text node
 * with the same font, width, tabs and padding also works after scrolling and
 * CSS zoom. The old selection is deliberately irrelevant to a mouse drop. */
export function sourceOffsetAtPoint(
  input: HTMLTextAreaElement,
  point: DropPosition,
): number | null {
  if (!input.isConnected || !containsDropPosition(input, point)) return null;
  const doc = input.ownerDocument;
  const style = doc.defaultView!.getComputedStyle(input);
  const rect = input.getBoundingClientRect();
  const scaleX = input.offsetWidth ? rect.width / input.offsetWidth : 1;
  const scaleY = input.offsetHeight ? rect.height / input.offsetHeight : scaleX;
  const borderLeft = parseFloat(style.borderLeftWidth) || 0;
  const borderTop = parseFloat(style.borderTopWidth) || 0;
  const x = (point.x - rect.left) / scaleX + input.scrollLeft - borderLeft;
  const y = (point.y - rect.top) / scaleY + input.scrollTop - borderTop;
  const mirror = doc.createElement('div');
  for (const property of [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'font-stretch',
    'font-variant-ligatures',
    'font-synthesis',
    'line-height',
    'letter-spacing',
    'word-spacing',
    'text-indent',
    'text-transform',
    'direction',
    'tab-size',
    'padding-top',
    'padding-bottom',
    'padding-left',
    'padding-right',
  ])
    mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: 'fixed',
    top: '0',
    left: '-100000px',
    width: `${input.clientWidth}px`,
    boxSizing: 'border-box',
    whiteSpace: input.wrap === 'off' ? 'pre' : 'pre-wrap',
    overflowWrap: 'break-word',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  // The zero-width sentinel gives a real caret rectangle for an empty document
  // and the final empty line. Its offset is never returned as source content.
  const value = input.value;
  const text = doc.createTextNode(value + '\u200b');
  mirror.append(text);
  doc.body.append(mirror);
  try {
    const origin = mirror.getBoundingClientRect();
    const range = doc.createRange();
    const characterRect = (offset: number) => {
      range.setStart(text, Math.min(offset, value.length));
      range.setEnd(text, Math.min(text.length, offset + 1));
      return range.getBoundingClientRect();
    };
    const at = (offset: number) => {
      const measured = characterRect(offset);
      return {
        top: measured.top - origin.top,
        bottom: measured.bottom - origin.top,
        left: measured.left - origin.left,
        right: measured.right - origin.left,
      };
    };
    // Vertical position is monotone across actual visual rows. Find the row
    // before considering x; logical newline counts do not account for wrapping.
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (at(middle).bottom < y) low = middle + 1;
      else high = middle;
    }
    const rowTop = at(low).top;
    let firstLow = 0;
    let firstHigh = low;
    while (firstLow < firstHigh) {
      const middle = (firstLow + firstHigh) >>> 1;
      if (at(middle).top < rowTop - 1) firstLow = middle + 1;
      else firstHigh = middle;
    }
    let lastLow = low;
    let lastHigh = value.length;
    while (lastLow < lastHigh) {
      const middle = (lastLow + lastHigh + 1) >>> 1;
      if (at(middle).top > rowTop + 1) lastHigh = middle - 1;
      else lastLow = middle;
    }
    let from = firstLow;
    let to = lastLow;
    // A deliberately unwrapped million-character line must not scan every
    // glyph. Narrow its visible LTR neighborhood by actual measured x first.
    if (to - from > 4096 && style.direction !== 'rtl') {
      let left = from;
      let right = to;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (at(middle).right < x) left = middle + 1;
        else right = middle;
      }
      from = Math.max(from, left - 32);
      to = Math.min(to, left + 32);
    }
    let best = from;
    let distance = Infinity;
    for (let offset = from; offset <= to; offset++) {
      // Source offsets are UTF-16, but a mouse insertion must not split a pair.
      if (
        offset > 0 &&
        /[\uD800-\uDBFF]/.test(value[offset - 1]) &&
        /[\uDC00-\uDFFF]/.test(value[offset] ?? '')
      )
        continue;
      range.setStart(text, offset);
      range.collapse(true);
      const caret = range.getBoundingClientRect();
      const caretX = caret.left - origin.left;
      const next = Math.abs(x - caretX);
      if (next < distance) {
        best = offset;
        distance = next;
      }
      // A line's final boundary can be before a newline or just after its last
      // glyph, whose collapsed range belongs to the following wrapped row.
      const character = at(offset);
      if (offset < value.length && value[offset] !== '\n') {
        const endDistance = Math.abs(x - character.right);
        if (endDistance < distance) {
          best = offset + (value.codePointAt(offset)! > 0xffff ? 2 : 1);
          distance = endDistance;
        }
      }
    }
    return Math.max(0, Math.min(value.length, best));
  } finally {
    mirror.remove();
  }
}

export interface SourcePositionLease {
  read: () => number | null;
  release: () => void;
}

function mapSourceDropOffset(before: string, after: string, offset: number): number {
  const mapped = mapTextOffset(before, after, offset);
  // Right affinity agrees with ProseMirror when new typing occurs exactly at
  // the original drop boundary: preserve that input before the arriving images.
  if (after.length > before.length && mapped === offset) {
    const inserted = after.length - before.length;
    if (
      before.slice(0, offset) === after.slice(0, offset) &&
      before.slice(offset) === after.slice(offset + inserted)
    )
      return offset + inserted;
  }
  return mapped;
}

/** Track individual source edits synchronously, plus exact migration mappings.
 * Previously observed short snapshots restore the anchor during undo/redo. */
export function trackSourcePosition(api: SourceEditorApi, position: number): SourcePositionLease {
  let text = api.read().text;
  let offset = Math.max(0, Math.min(text.length, position));
  let released = false;
  const known = new Map<string, number>();
  let retained = 0;
  const remember = () => {
    if (text.length > 4 * 1024 * 1024) return;
    if (!known.has(text)) retained += text.length;
    known.set(text, offset);
    while (known.size > 32 || retained > 4 * 1024 * 1024) {
      const oldest = known.keys().next().value!;
      retained -= oldest.length;
      known.delete(oldest);
    }
  };
  remember();
  const update = (
    before: string,
    after: string,
    edits?: readonly SourceTextEdit[],
    mapper?: (offset: number) => number,
  ) => {
    if (released || after === text) return;
    if (before !== text) offset = mapSourceDropOffset(text, before, offset);
    const insertionAtAnchor = edits?.find((edit) => edit.from === offset && edit.to === offset);
    if (mapper) offset = mapper(offset) + (insertionAtAnchor?.text.length ?? 0);
    else if (edits) {
      offset = mapSourceEditOffset(offset, edits) + (insertionAtAnchor?.text.length ?? 0);
    } else offset = known.get(after) ?? mapSourceDropOffset(before, after, offset);
    text = after;
    offset = Math.max(0, Math.min(text.length, offset));
    remember();
  };
  const unsubscribe = subscribeSourceEditorChanges(api, update);
  return {
    read: () => {
      if (released) return null;
      const current = api.read().text;
      if (current !== text) update(text, current);
      return offset;
    },
    release: () => {
      if (released) return;
      released = true;
      unsubscribe();
      known.clear();
    },
  };
}

export interface CapturedImageDrop {
  tabId: string;
  invalidReason: () => ImageDropReason | undefined;
  insert: (placeholders: readonly string[]) => boolean;
  release: () => void;
}

export interface ImageDropOperations {
  importImage: (path: string, tabId: string) => Promise<string>;
  protectImage: (tabId: string, placeholder: string, isCurrent: () => boolean) => Promise<void>;
  cancelImage: (tabId: string, placeholder: string) => Promise<void>;
  settleImage: (tabId: string, placeholder: string) => void;
}

const imageOperations: ImageDropOperations = {
  importImage: (path, tabId) => importDroppedImage(path, tabId),
  protectImage: (tabId, placeholder, isCurrent) =>
    protectPastedImage(tabId, placeholder, isCurrent),
  cancelImage: (tabId, placeholder) => cancelImageInsertion(tabId, placeholder),
  settleImage: (tabId, placeholder) => settleImageInsertion(tabId, placeholder),
};

/** Complete native imports/protection before one editor transaction. Failed
 * files contribute no references, while successful files keep natural order. */
export async function runImageDrop(
  paths: readonly string[],
  target: CapturedImageDrop,
  operations: ImageDropOperations = imageOperations,
  onProgress?: (progress: ImageDropProgress) => void,
): Promise<ImageDropResult> {
  const result: ImageDropResult = { attempted: paths.length, inserted: 0, failures: [] };
  const ready: string[] = [];
  const isCurrent = () => target.invalidReason() === undefined;
  let completed = 0;
  try {
    onProgress?.({ completed, total: paths.length });
    for (const path of sortDroppedImages(paths)) {
      const reason = target.invalidReason();
      if (reason) {
        result.reason = reason;
        break;
      }
      let placeholder = '';
      try {
        placeholder = await operations.importImage(path, target.tabId);
        if (!placeholder) throw new Error('图片导入未返回有效引用');
        const invalid = target.invalidReason();
        if (invalid) {
          result.reason = invalid;
          await operations.cancelImage(target.tabId, placeholder);
          break;
        }
        await operations.protectImage(target.tabId, placeholder, isCurrent);
        const afterProtection = target.invalidReason();
        if (afterProtection) {
          result.reason = afterProtection;
          await operations.cancelImage(target.tabId, placeholder);
          break;
        }
        ready.push(placeholder);
      } catch (error) {
        if (placeholder)
          await operations
            .cancelImage(target.tabId, placeholder)
            .catch((cleanupError) => console.error('释放未插入图片失败', cleanupError));
        const invalid = target.invalidReason();
        if (invalid) {
          result.reason = invalid;
          break;
        }
        result.failures.push({ path, message: errorMessage(error) });
      } finally {
        onProgress?.({ completed: ++completed, total: paths.length });
      }
    }
    result.reason ??= target.invalidReason();
    if (!result.reason && ready.length) {
      if (target.insert([...ready])) {
        result.inserted = ready.length;
        for (const placeholder of ready) operations.settleImage(target.tabId, placeholder);
        ready.length = 0;
      } else result.reason = target.invalidReason() ?? 'editor-unavailable';
    }
    return result;
  } finally {
    target.release();
    await Promise.all(
      ready.map((placeholder) =>
        operations
          .cancelImage(target.tabId, placeholder)
          .catch((error) => console.error('释放取消拖入图片失败', error)),
      ),
    );
  }
}
