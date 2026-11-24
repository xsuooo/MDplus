import { win32 } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const paths = vi.hoisted(() => ({ dirname: vi.fn(), join: vi.fn() }));
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => paths);
vi.mock('@tauri-apps/api/core', () => core);
import { externalLinkUrl, openExternalLink, resolveDocumentLink } from '../src/lib/documentLinks';

beforeEach(() => {
  paths.dirname.mockReset().mockImplementation(win32.dirname);
  paths.join.mockReset().mockImplementation(win32.join);
  core.invoke.mockReset().mockResolvedValue(undefined);
});
describe('web links open in the system browser', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    [
      'HTTP://Example.COM/a b?q=中文#顶部',
      'http://example.com/a%20b?q=%E4%B8%AD%E6%96%87#%E9%A1%B6%E9%83%A8',
    ],
    ['  https://example.com/a.md  ', 'https://example.com/a.md'],
    ['https://example.com/path?x=1&y=2', 'https://example.com/path?x=1&y=2'],
  ])('hands %s to the native opener as one serialized address', async (href, url) => {
    expect(externalLinkUrl(href)).toBe(url);
    await openExternalLink(href);
    expect(core.invoke).toHaveBeenCalledExactlyOnceWith('open_external_link', { url });
  });
  it.each([
    './说明.md',
    '../a.markdown',
    '#标题',
    'file:///C:/a.md',
    'C:/a.md',
    '//example.com/a',
    'javascript:alert(1)',
    'mailto:a@example.com',
    'ms-settings:privacy',
    'https://',
    'https:example.com',
    '',
  ])('never treats %s as a web link', async (href) => {
    expect(externalLinkUrl(href)).toBeNull();
    await expect(openExternalLink(href)).rejects.toThrow('http');
    expect(core.invoke).not.toHaveBeenCalled();
  });
  it('reports the address when the system cannot open it', async () => {
    core.invoke.mockRejectedValue('the system could not open the link (code 31)');
    await expect(openExternalLink('https://example.com/x')).rejects.toThrow(
      '无法在浏览器中打开链接：https://example.com/x',
    );
  });
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
