import { describe, expect, it, vi } from 'vitest';
import {
  EDITOR_WIDTH_STORAGE_KEY,
  normalizeEditorWidth,
  readEditorWidth,
  writeEditorWidth,
} from '../src/lib/editorWidth';

describe('editor width preference', () => {
  it('remembers full width and falls back to centered reading for invalid storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(readEditorWidth(storage)).toBe('centered');
    writeEditorWidth('full', storage);
    expect(readEditorWidth(storage)).toBe('full');
    values.set(EDITOR_WIDTH_STORAGE_KEY, 'unexpected');
    expect(readEditorWidth(storage)).toBe('centered');
    for (const value of [null, undefined, '', {}, 1, '100%'])
      expect(normalizeEditorWidth(value)).toBe('centered');
  });

  it('does not interrupt editing when storage is unavailable', () => {
    const fail = vi.fn(() => {
      throw new Error('Storage unavailable');
    });
    expect(readEditorWidth({ getItem: fail })).toBe('centered');
    expect(() => writeEditorWidth('full', { setItem: fail })).not.toThrow();
  });
});
