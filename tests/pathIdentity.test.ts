import { describe, expect, it } from 'vitest';
import { pathKey } from '../src/lib/pathIdentity';

describe('Windows document comparison keys', () => {
  it.each([
    'C:/Notes/a.md',
    'c:\\notes\\.\\a.md',
    'C:/notes/sub/../a.md',
    '\\\\?\\C:\\notes\\a.md',
    'C:/notes/../../notes/a.md',
  ])('normalizes equivalent drive paths: %s', (path) => {
    expect(pathKey(path)).toBe('c:\\notes\\a.md');
  });

  it.each([
    '\\\\server\\share\\notes\\a.md',
    '//SERVER/share/notes/./a.md',
    '\\\\?\\UNC\\server\\share\\notes\\sub\\..\\a.md',
  ])('normalizes UNC and extended UNC paths: %s', (path) => {
    expect(pathKey(path)).toBe('\\\\server\\share\\notes\\a.md');
  });

  it('does not collapse a UNC path above its share root', () => {
    expect(pathKey('//server/share/../../notes/a.md')).toBe('\\\\server\\share\\notes\\a.md');
  });

  it('retains unresolved relative parents and drive-relative semantics', () => {
    expect(pathKey('../notes/./sub/../a.md')).toBe('..\\notes\\a.md');
    expect(pathKey('C:notes/a.md')).toBe('c:notes\\a.md');
    expect(pathKey('C:../a.md')).toBe('c:..\\a.md');
    expect(pathKey('a.md')).not.toBe(pathKey('C:/notes/a.md'));
    expect(pathKey('C:notes/a.md')).not.toBe(pathKey('C:/notes/a.md'));
  });

  it('keeps different shares and filenames distinct', () => {
    expect(pathKey('//server/one/a.md')).not.toBe(pathKey('//server/two/a.md'));
    expect(pathKey('C:/notes/a.md')).not.toBe(pathKey('C:/notes/b.md'));
  });
});
