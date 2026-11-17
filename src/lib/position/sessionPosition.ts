/** Small text contexts locate a position after a disk edit without retaining a draft. */
export interface TextAnchor {
  offset: number;
  before: string;
  after: string;
  line: number;
  column: number;
}

export interface SessionEditorPlace {
  sourceMode: boolean;
  start: TextAnchor;
  end: TextAnchor;
  direction: 'forward' | 'backward' | 'none';
  scroll?: { anchor: TextAnchor; gap: number; fraction?: number };
  top: number;
  left: number;
}

const CONTEXT_LENGTH = 40;
const MAX_OFFSET = 0x7fffffff;

function position(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_OFFSET
    ? value
    : null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function sanitizeAnchor(value: unknown): TextAnchor | null {
  const anchor = record(value);
  if (!anchor) return null;
  const offset = position(anchor.offset);
  const line = position(anchor.line);
  const column = position(anchor.column);
  if (
    offset === null ||
    line === null ||
    column === null ||
    typeof anchor.before !== 'string' ||
    typeof anchor.after !== 'string' ||
    anchor.before.length > CONTEXT_LENGTH ||
    anchor.after.length > CONTEXT_LENGTH
  )
    return null;
  return {
    offset: Math.floor(offset),
    before: anchor.before,
    after: anchor.after,
    line: Math.floor(line),
    column: Math.floor(column),
  };
}

export function sanitizeSessionPlace(value: unknown): SessionEditorPlace | undefined {
  const place = record(value);
  if (!place || typeof place.sourceMode !== 'boolean') return;
  const start = sanitizeAnchor(place.start);
  const end = sanitizeAnchor(place.end);
  const top = position(place.top);
  const left = position(place.left);
  if (!start || !end || top === null || left === null) return;
  const direction = place.direction;
  if (direction !== 'forward' && direction !== 'backward' && direction !== 'none') return;
  const saved: SessionEditorPlace = {
    sourceMode: place.sourceMode,
    start,
    end,
    direction,
    top,
    left,
  };
  const scroll = record(place.scroll);
  const scrollAnchor = sanitizeAnchor(scroll?.anchor);
  if (
    scrollAnchor &&
    typeof scroll?.gap === 'number' &&
    Number.isFinite(scroll.gap) &&
    Math.abs(scroll.gap) <= 100000
  ) {
    saved.scroll = { anchor: scrollAnchor, gap: scroll.gap };
    if (typeof scroll.fraction === 'number' && Number.isFinite(scroll.fraction))
      saved.scroll.fraction = Math.max(0, Math.min(1, scroll.fraction));
  }
  return saved;
}

export function textAnchor(markdown: string, offset: number): TextAnchor {
  const at = Math.min(markdown.length, Math.max(0, Math.floor(offset)));
  const prefix = markdown.slice(0, at);
  const lastBreak = prefix.lastIndexOf('\n');
  return {
    offset: at,
    before: markdown.slice(Math.max(0, at - CONTEXT_LENGTH), at),
    after: markdown.slice(at, at + CONTEXT_LENGTH),
    line: prefix.split('\n').length - 1,
    column: at - lastBreak - 1,
  };
}

/** Prefer a matching context near the old offset; fall back to its line and column. */
export function resolveTextAnchor(markdown: string, anchor: TextAnchor): number {
  const clamp = (value: number) => Math.max(0, Math.min(markdown.length, value));
  const expected = clamp(anchor.offset);
  if (
    markdown.slice(Math.max(0, expected - anchor.before.length), expected) === anchor.before &&
    markdown.slice(expected, expected + anchor.after.length) === anchor.after
  )
    return expected;
  const find = (needle: string, delta: number): number | null => {
    if (!needle) return null;
    let candidate: number | null = null;
    let distance = Infinity;
    let offset = markdown.indexOf(needle);
    // Bound work for repetitive documents while still considering nearby matches.
    let attempts = 0;
    while (offset >= 0 && attempts++ < 4096) {
      const at = offset + delta;
      const nextDistance = Math.abs(at - anchor.offset);
      if (nextDistance < distance) {
        candidate = at;
        distance = nextDistance;
      }
      if (at >= anchor.offset) break;
      offset = markdown.indexOf(needle, offset + 1);
    }
    return candidate;
  };
  const combined = find(anchor.before + anchor.after, anchor.before.length);
  if (combined !== null) return clamp(combined);
  // A local edit can destroy one half of a context. The other half still provides an anchor.
  const after = find(anchor.after, 0);
  const before = find(anchor.before, anchor.before.length);
  if (after !== null && before !== null)
    return clamp(
      Math.abs(after - anchor.offset) <= Math.abs(before - anchor.offset) ? after : before,
    );
  if (after !== null || before !== null) return clamp(after ?? before!);
  let lineStart = 0;
  for (let line = 0; line < anchor.line; line++) {
    const next = markdown.indexOf('\n', lineStart);
    if (next < 0) return expected;
    lineStart = next + 1;
  }
  const lineEnd = markdown.indexOf('\n', lineStart);
  return clamp(Math.min(lineStart + anchor.column, lineEnd < 0 ? markdown.length : lineEnd));
}
