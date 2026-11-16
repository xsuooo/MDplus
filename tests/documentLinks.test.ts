import { win32 } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const paths = vi.hoisted(() => ({ dirname: vi.fn(), join: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => paths);
import { resolveDocumentLink } from '../src/lib/documentLinks';

beforeEach(() => {
  paths.dirname.mockReset().mockImplementation(win32.dirname);
  paths.join.mockReset().mockImplementation(win32.join);
});
describe('relative Markdown document navigation', () => {
  it.each([
    ['./说明.md', 'C:\\notes\\说明.md'],
    ['../另一个目录/Guide.MARKDOWN', 'C:\\另一个目录\\Guide.MARKDOWN'],
    ['./中文%20空间.md', 'C:\\notes\\中文 空间.md'],
    ['./100%25.md', 'C:\\notes\\100%.md'],
    ['./literal%2520.md', 'C:\\notes\\literal%20.md'],
    ['./file%23name.md#标题', 'C:\\notes\\file#name.md'],
    ['./literal%xx.md', 'C:\\notes\\literal%xx.md'],
  ])('resolves %s once from the saved source directory', async (href, path) => {
    expect(await resolveDocumentLink(href, 'C:\\notes\\source.md')).toEqual({
      path,
      hasFragment: href.includes('#'),
    });
  });
  it.each([
    'https://example.com/a.md',
    'file:///C:/a.md',
    'C:/a.md',
    'C:a.md',
    '//server/a.md',
    '\\server\\a.md',
    '%2Fa.md',
    '%5C%5Cserver%5Ca.md',
    '%43%3Aa.md',
    './picture.png',
    './a.md?query=1',
    '#标题',
  ])('rejects unsupported target %s before native path calls', async (href) => {
    await expect(resolveDocumentLink(href, 'C:/notes/source.md')).rejects.toThrow();
    expect(paths.join).not.toHaveBeenCalled();
    expect(paths.dirname).not.toHaveBeenCalled();
  });
  it('requires a saved source and uses the new directory after Save As', async () => {
    await expect(resolveDocumentLink('./target.md', null)).rejects.toThrow('先保存');
    expect((await resolveDocumentLink('./target.md', 'D:\\new\\source.md')).path).toBe(
      'D:\\new\\target.md',
    );
  });
});
