import { describe, expect, it } from 'vitest';
import { sanitizeRecentFiles, sanitizeSourceMode, sanitizeThemeMode } from '../src/lib/validation';

describe('persisted settings validation', () => {
  it('drops malformed recent file entries and caps the list', () => {
    const result = sanitizeRecentFiles(
      [
        { path: 'C:/notes/one.md', name: 'one.md', time: 10 },
        { path: '', name: 'empty.md', time: 9 },
        { path: 'C:/notes/two.md', name: 'two.md' },
        null,
        { path: 'C:/notes/three.md', name: 3 },
      ],
      2,
    );

    expect(result).toEqual([
      { path: 'C:/notes/one.md', name: 'one.md', time: 10 },
      { path: 'C:/notes/two.md', name: 'two.md', time: 0 },
    ]);
  });

  it('falls back to safe preference values', () => {
    expect(sanitizeThemeMode('dark')).toBe('dark');
    expect(sanitizeThemeMode('invalid')).toBe('light');
    expect(sanitizeSourceMode(true)).toBe(true);
    expect(sanitizeSourceMode('true')).toBe(false);
  });
});
