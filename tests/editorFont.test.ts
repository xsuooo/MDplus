import { describe, expect, it, vi } from 'vitest';
import { BODY_FONTS, CODE_FONTS, BODY_FONT_STORAGE_KEY, CODE_FONT_STORAGE_KEY, DEFAULT_BODY_FONT, DEFAULT_CODE_FONT,
  normalizeBodyFont, normalizeCodeFont, readBodyFont, readCodeFont, writeBodyFont, writeCodeFont } from '../src/lib/editorFont';

describe('editor font preferences', () => {
  it.each(CODE_FONTS)('accepts the bundled $id code preset', ({ id }) => {
    expect(normalizeCodeFont(id)).toBe(id);
    expect(readCodeFont({ getItem: () => id })).toBe(id);
  });
  it.each(BODY_FONTS)('accepts the proportional $id body preset', ({ id }) => {
    expect(normalizeBodyFont(id)).toBe(id);
    expect(readBodyFont({ getItem: () => id })).toBe(id);
  });

  it.each([null, undefined, '', 'unknown', 123])('defaults safely for %s', (value) => {
    expect(normalizeCodeFont(value)).toBe(DEFAULT_CODE_FONT);
    expect(normalizeBodyFont(value)).toBe(DEFAULT_BODY_FONT);
  });

  it('persists the preset without requiring disk or native IPC access', () => {
    const setItem = vi.fn();
    writeCodeFont('fira-wenkai', { setItem });
    writeBodyFont('wenkai', { setItem });
    expect(setItem).toHaveBeenCalledWith(CODE_FONT_STORAGE_KEY, 'fira-wenkai');
    expect(setItem).toHaveBeenCalledWith(BODY_FONT_STORAGE_KEY, 'wenkai');
  });

  it('keeps the old pair choice for code without overriding body defaults', () => {
    const storage = { getItem: (key: string) => key === 'mdplus-editor-font' ? 'cascadia-misans' : null };
    expect(readCodeFont(storage)).toBe('cascadia-misans');
    expect(readBodyFont(storage)).toBe('misans');
  });

  it('does not interrupt editing when preference storage fails', () => {
    const fail = () => { throw new Error('Storage disabled'); };
    expect(readCodeFont({ getItem: fail })).toBe(DEFAULT_CODE_FONT);
    expect(readBodyFont({ getItem: fail })).toBe(DEFAULT_BODY_FONT);
    expect(() => writeCodeFont('cascadia-misans', { setItem: fail })).not.toThrow();
    expect(() => writeBodyFont('wenkai', { setItem: fail })).not.toThrow();
  });
});
