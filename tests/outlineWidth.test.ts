import { describe, expect, it } from 'vitest';
import {
  OUTLINE_WIDTH_DEFAULT,
  OUTLINE_WIDTH_MAX,
  OUTLINE_WIDTH_MIN,
  OUTLINE_WIDTH_STORAGE_KEY,
  normalizeOutlineWidth,
  readOutlineWidth,
  writeOutlineWidth,
} from '../src/lib/outlineWidth';

describe('normalizeOutlineWidth', () => {
  it('keeps values inside the allowed range', () => {
    expect(normalizeOutlineWidth(260)).toBe(260);
    expect(normalizeOutlineWidth(OUTLINE_WIDTH_MIN)).toBe(OUTLINE_WIDTH_MIN);
    expect(normalizeOutlineWidth(OUTLINE_WIDTH_MAX)).toBe(OUTLINE_WIDTH_MAX);
  });

  it('clamps out-of-range widths', () => {
    expect(normalizeOutlineWidth(10)).toBe(OUTLINE_WIDTH_MIN);
    expect(normalizeOutlineWidth(5000)).toBe(OUTLINE_WIDTH_MAX);
    expect(normalizeOutlineWidth(-200)).toBe(OUTLINE_WIDTH_MIN);
  });

  it('rounds fractional drag positions', () => {
    expect(normalizeOutlineWidth(259.6)).toBe(260);
  });

  it('falls back to the default for unusable values', () => {
    expect(normalizeOutlineWidth(Number.NaN)).toBe(OUTLINE_WIDTH_DEFAULT);
    expect(normalizeOutlineWidth(Number.POSITIVE_INFINITY)).toBe(OUTLINE_WIDTH_DEFAULT);
    expect(normalizeOutlineWidth('wide')).toBe(OUTLINE_WIDTH_DEFAULT);
    expect(normalizeOutlineWidth(undefined)).toBe(OUTLINE_WIDTH_DEFAULT);
  });
});

describe('outline width storage', () => {
  it('reads a stored width through the normalizer', () => {
    const getItem = (key: string) => (key === OUTLINE_WIDTH_STORAGE_KEY ? '320' : null);
    expect(readOutlineWidth({ getItem })).toBe(320);
    expect(readOutlineWidth({ getItem: () => '9000' })).toBe(OUTLINE_WIDTH_MAX);
  });

  it('falls back to the default for empty or broken values', () => {
    expect(readOutlineWidth({ getItem: () => null })).toBe(OUTLINE_WIDTH_DEFAULT);
    expect(readOutlineWidth({ getItem: () => '   ' })).toBe(OUTLINE_WIDTH_DEFAULT);
    expect(readOutlineWidth({ getItem: () => 'abc' })).toBe(OUTLINE_WIDTH_DEFAULT);
  });

  it('survives a storage that throws on read', () => {
    expect(readOutlineWidth({ getItem: () => { throw new Error('denied'); } })).toBe(OUTLINE_WIDTH_DEFAULT);
  });

  it('writes the clamped width under the expected key and swallows failures', () => {
    const calls: Array<[string, string]> = [];
    writeOutlineWidth(5000, { setItem: (key, value) => { calls.push([key, value]); } });
    expect(calls).toEqual([[OUTLINE_WIDTH_STORAGE_KEY, String(OUTLINE_WIDTH_MAX)]]);
    expect(() => writeOutlineWidth(260, { setItem: () => { throw new Error('quota'); } })).not.toThrow();
  });
});

describe('outline panel stylesheet', () => {
  it('drives the panel width with a flex-basis variable, not the flex shorthand', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8');
    const block = css.slice(css.indexOf('.outline {'), css.indexOf('.outline.collapsed'));
    expect(block).toContain('flex-basis: var(--outline-width, 230px)');
    // flex 简写里放 var() 会让 WebView2 丢掉整条声明,宽度就会退回内容宽度。
    expect(block).not.toContain('flex: 0 0 var(');
  });
});
