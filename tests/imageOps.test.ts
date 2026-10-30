import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  readImageFile: vi.fn(),
  fileMtime: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => path.win32.join(...parts),
  dirname: async (file: string) => path.win32.dirname(file),
}));
vi.mock('../src/lib/fileOps', () => ({
  basename: (file: string) => path.win32.basename(file),
  readImageFile: mocks.readImageFile,
  fileMtime: mocks.fileMtime,
}));

import { clearPendingImages, commitImageMigration, loadImageReferences, migratePendingImages, resolveImageSource, saveImage } from '../src/lib/imageOps';

const document = 'C:\\notes\\note.md';
const original = '![](./img/pic.png)';

beforeEach(() => {
  clearPendingImages('tab');
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.fileMtime.mockRejectedValue(new Error('not found'));
  mocks.readImageFile.mockResolvedValue({
    path: '\\\\?\\C:\\notes\\img\\pic.png',
    mime: 'image/png',
    data: [65, 66, 67],
  });
});

describe('document image loading and migration', () => {
  it('resolves saved image references from the tab cache without changing Markdown', async () => {
    const display = await loadImageReferences('tab', original, document);
    const placeholder = display.slice(4, -1);
    expect(placeholder).toMatch(/^mdplus-image:[\w-]+$/);
    expect(display).not.toContain('base64');
    const preview = 'data:image/png;base64,QUJD';
    expect(resolveImageSource('tab', placeholder)).toBe(preview);
    expect(resolveImageSource('tab', './img/pic.png')).toBe(preview);
    expect(resolveImageSource('other-tab', './img/pic.png')).toBe('./img/pic.png');
    expect(resolveImageSource('tab', 'https://example.com/pic.png')).toBe('https://example.com/pic.png');

    const savedAs = await migratePendingImages('tab', 'D:\\new\\note.md', display);
    expect(resolveImageSource('tab', './assets/pic.png')).toBe('./assets/pic.png');
    commitImageMigration(savedAs);
    expect(savedAs.markdown).toBe('![](./assets/pic.png)');
    expect(resolveImageSource('tab', './assets/pic.png')).toBe(preview);
    expect(resolveImageSource('tab', placeholder)).toBe(preview);
    clearPendingImages('tab');
    expect(resolveImageSource('tab', './assets/pic.png')).toBe('./assets/pic.png');
  });

  it('keeps image titles through loading, editing, saving and SaveAs', async () => {
    const markdown = '![photo](./img/pic.png "caption")';
    const display = await loadImageReferences('tab', markdown, document);
    expect(display).toMatch(/^!\[photo\]\(mdplus-image:[\w-]+ "caption"\)$/);
    expect(mocks.readImageFile).toHaveBeenCalledWith(document, 'img/pic.png');

    const edited = display.replace('caption', 'edited caption');
    const saved = await migratePendingImages('tab', document, edited);
    expect(saved.markdown).toBe('![photo](./img/pic.png "edited caption")');
    expect(mocks.invoke).not.toHaveBeenCalled();
    commitImageMigration(saved);

    const savedAs = await migratePendingImages('tab', 'D:\\new\\note.md', saved.markdown);
    expect(savedAs.markdown).toBe('![photo](./assets/pic.png "edited caption")');
    expect(mocks.invoke).toHaveBeenCalledWith('save_binary_file', {
      path: 'D:\\new\\assets\\pic.png', data: [65, 66, 67],
    });
  });

  it.each([
    ['![photo](<./img/my pic.png> "caption")', 'img/my pic.png', '![photo](<./assets/my pic.png> "caption")'],
    ['![photo](./img/a(b(c)).png "caption")', 'img/a(b(c)).png', String.raw`![photo](./assets/a\(b\(c\)\).png "caption")`],
    [String.raw`![photo](./img/a\(b\).png "caption")`, 'img/a(b).png', String.raw`![photo](./assets/a\(b\).png "caption")`],
    ['![photo][id]\n\n[id]: ./img/pic.png "caption"', 'img/pic.png', '![photo][id]\n\n[id]: ./assets/pic.png "caption"'],
  ])('loads and migrates the same destination in %s', async (markdown, relativePath, expected) => {
    mocks.readImageFile.mockResolvedValue({
      path: path.win32.join('C:\\notes', relativePath), mime: 'image/png', data: [65, 66, 67],
    });
    const display = await loadImageReferences('tab', markdown, document);
    expect(display).toContain('mdplus-image:');
    expect(mocks.readImageFile).toHaveBeenCalledExactlyOnceWith(document, relativePath);
    const savedAs = await migratePendingImages('tab', 'D:\\new\\note.md', display);
    expect(savedAs.markdown).toBe(expected);
    expect(resolveImageSource('tab', `./${relativePath}`)).toBe('data:image/png;base64,QUJD');
    expect(savedAs.markdown).not.toContain('mdplus-image:');
  });

  it('migrates images sharing a link definition without changing the download link', async () => {
    const markdown = '![photo][shared] [download][shared]\n\n[shared]: ./img/pic.png "caption"';
    const display = await loadImageReferences('tab', markdown, document);
    expect(display).toMatch(/^!\[photo\]\(mdplus-image:[\w-]+ "caption"\) \[download\]\[shared\]/);
    expect(display).toContain('[shared]: ./img/pic.png "caption"');
    const savedAs = await migratePendingImages('tab', 'D:\\new\\note.md', display);
    expect(savedAs.markdown).toBe('![photo](./assets/pic.png "caption") [download][shared]\n\n[shared]: ./img/pic.png "caption"');
    expect(mocks.invoke).toHaveBeenCalledWith('save_binary_file', {
      path: 'D:\\new\\assets\\pic.png', data: [65, 66, 67],
    });
  });

  it('keeps shared titles with encoded blank lines through load and SaveAs', async () => {
    const markdown = '![photo][shared] [download][shared]\n\n[shared]: ./img/pic.png "one&#10;&#10;two"';
    const display = await loadImageReferences('tab', markdown, document);
    expect(display).toContain('mdplus-image:');
    const savedAs = await migratePendingImages('tab', 'D:\\new\\note.md', display);
    expect(savedAs.markdown).not.toContain('mdplus-image:');
    expect(savedAs.markdown).toContain('![photo](./assets/pic.png "one&#10;&#10;two")');
    expect(savedAs.markdown).toContain('[download][shared]');
    expect(mocks.invoke).toHaveBeenCalledWith('save_binary_file', {
      path: 'D:\\new\\assets\\pic.png', data: [65, 66, 67],
    });
  });

  it('migrates cached images between code markers in separate GFM table cells', async () => {
    const display = await loadImageReferences('tab', original, document);
    const markdown = `| a | b | c |\n| - | - | - |\n| \` | ${display} | \` |`;
    const savedAs = await migratePendingImages('tab', 'D:\\new\\note.md', markdown);
    expect(savedAs.markdown).toBe(markdown.replace(display, '![](./assets/pic.png)'));
    expect(savedAs.markdown).not.toContain('mdplus-image:');
    expect(mocks.invoke).toHaveBeenCalledWith('save_binary_file', {
      path: 'D:\\new\\assets\\pic.png', data: [65, 66, 67],
    });
  });

  it('rejects unknown image tokens inside GFM table cells before writing assets', async () => {
    const markdown = '| a | b | c |\n| - | - | - |\n| ` | ![lost](mdplus-image:missing) | ` |';
    await expect(migratePendingImages('tab', document, markdown))
      .rejects.toThrow(/图片.*mdplus-image:missing/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    '$![example](mdplus-image:missing)$',
    '$$\n![example](mdplus-image:missing)\n$$',
    '$![example][ref]$\n\n[ref]: mdplus-image:missing',
  ])('does not reject image-like token examples in math: %s', async (markdown) => {
    const migration = await migratePendingImages('tab', document, markdown);
    expect(migration.markdown).toBe(markdown);
    expect(migration.updates).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects unknown image tokens before writing any assets (cached: %s)', async (hasCachedImage) => {
    const display = hasCachedImage ? await loadImageReferences('tab', original, document) : '';
    const markdown = `${display}\n![lost](mdplus-image:missing "caption")`;

    await expect(migratePendingImages('tab', 'D:\\new\\note.md', markdown))
      .rejects.toThrow(/图片.*mdplus-image:missing/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('ignores token examples in prose, links, code and unused definitions during migration', async () => {
    const markdown = [
      'Example token: mdplus-image:example',
      '[ordinary](mdplus-image:link)',
      '`![inline](mdplus-image:code)`',
      '',
      '~~~markdown',
      '![fenced](mdplus-image:fence "caption")',
      '~~~',
      '',
      '    ![indented](mdplus-image:indent)',
      '',
      '[unused]: mdplus-image:unused',
    ].join('\n');

    const migration = await migratePendingImages('tab', document, markdown);
    expect(migration.markdown).toBe(markdown);
    expect(migration.updates).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('rejects unknown tokens in image reference definitions, not just inline images', async () => {
    await expect(migratePendingImages('tab', document, '![lost][photo]\n\n[photo]: <mdplus-image:missing> "caption"'))
      .rejects.toThrow(/图片.*mdplus-image:missing/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('passes document-relative references to the validated backend reader', async () => {
    mocks.readImageFile.mockRejectedValue(new Error('outside document directory'));
    const markdown = '![](../../private/secret.txt)';
    expect(await loadImageReferences('tab', markdown, document)).toBe(markdown);
    expect(mocks.readImageFile).toHaveBeenCalledWith(document, '../../private/secret.txt');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('does not send compact tokens to the file reader', async () => {
    const display = await loadImageReferences('tab', original, document);
    mocks.readImageFile.mockClear();
    expect(await loadImageReferences('tab', display, document)).toBe(display);
    expect(mocks.readImageFile).not.toHaveBeenCalled();
  });

  it('does not change ordinary text that mentions an image filename', async () => {
    const markdown = `File: ./img/pic.png\n${original}`;
    const display = await loadImageReferences('tab', markdown, document);
    expect(display).toMatch(/^File: \.\/img\/pic\.png\n!\[\]\(mdplus-image:[\w-]+\)$/);
  });

  it('keeps existing image paths on save, then copies them on a later SaveAs', async () => {
    const display = await loadImageReferences('tab', original, document);
    const saved = await migratePendingImages('tab', document, display);
    commitImageMigration(saved);
    expect(saved.markdown).toBe(original);
    expect(mocks.invoke).not.toHaveBeenCalled();

    const savedAs = await migratePendingImages('tab', 'D:\\new\\note.md', saved.markdown);
    commitImageMigration(savedAs);
    expect(savedAs.markdown).toBe('![](./assets/pic.png)');
    expect(mocks.invoke).toHaveBeenCalledWith('save_binary_file', {
      path: 'D:\\new\\assets\\pic.png', data: [65, 66, 67],
    });
    mocks.invoke.mockClear();
    const repeated = await migratePendingImages('tab', 'D:\\new\\note.md', savedAs.markdown);
    expect(repeated.markdown).toBe(savedAs.markdown);
    expect(mocks.invoke).not.toHaveBeenCalled();

    const third = await migratePendingImages('tab', 'E:\\third\\note.md', repeated.markdown);
    expect(third.markdown).toBe('![](./assets/pic.png)');
    expect(mocks.invoke).toHaveBeenCalledWith('save_binary_file', {
      path: 'E:\\third\\assets\\pic.png', data: [65, 66, 67],
    });
  });

  it('does not commit source paths when the document write fails', async () => {
    const display = await loadImageReferences('tab', original, document);
    await migratePendingImages('tab', 'D:\\failed\\note.md', display);
    mocks.invoke.mockClear();
    const retry = await migratePendingImages('tab', document, display);
    expect(retry.markdown).toBe(original);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('leaves cached sources unchanged when an image migration fails', async () => {
    const display = await loadImageReferences('tab', original, document);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'save_binary_file') throw new Error('disk full');
    });
    await expect(migratePendingImages('tab', 'D:\\failed\\note.md', display)).rejects.toThrow('disk full');
    expect(resolveImageSource('tab', './assets/pic.png')).toBe('./assets/pic.png');
    mocks.invoke.mockClear();
    const retry = await migratePendingImages('tab', document, display);
    expect(retry.markdown).toBe(original);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('migrates both saved references and retained preview placeholders', async () => {
    const display = await loadImageReferences('tab', original, document);
    const saved = await migratePendingImages('tab', document, display);
    commitImageMigration(saved);
    const next = await migratePendingImages('tab', 'D:\\new\\note.md', `${saved.markdown}\n${display}`);
    expect(next.markdown).toBe('![](./assets/pic.png)\n![](./assets/pic.png)');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'save_binary_file')).toHaveLength(1);
  });

  it('keeps different filenames when images have identical bytes', async () => {
    mocks.readImageFile.mockImplementation(async (_doc: string, relative: string) => ({
      path: path.win32.join('C:\\notes', relative), mime: 'image/png', data: [65, 66, 67],
    }));
    const markdown = '![](./img/one.png)\n![](./img/two.png)';
    const display = await loadImageReferences('tab', markdown, document);
    const tokens = [...display.matchAll(/mdplus-image:[\w-]+/g)].map(([token]) => token);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(resolveImageSource('tab', tokens[0])).toBe(resolveImageSource('tab', tokens[1]));
    const saved = await migratePendingImages('tab', document, display);
    expect(saved.markdown).toBe(markdown);
    const savedAs = await migratePendingImages('tab', 'D:\\new\\note.md', display);
    expect(savedAs.markdown).toBe('![](./assets/one.png)\n![](./assets/two.png)');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'save_binary_file')).toHaveLength(2);
  });

  it('retains pasted image data after its first save', async () => {
    class TestFileReader {
      result = 'data:image/png;base64,QUJD';
      onload: (() => void) | null = null;
      readAsDataURL() { this.onload?.(); }
    }
    vi.stubGlobal('FileReader', TestFileReader);
    try {
      const placeholder = await saveImage(new Blob(['ABC'], { type: 'image/png' }), 'tab');
      expect(placeholder).toMatch(/^mdplus-image:[\w-]+$/);
      expect(placeholder.length).toBeLessThan(70);
      expect(resolveImageSource('tab', placeholder)).toBe('data:image/png;base64,QUJD');
      expect(mocks.invoke).not.toHaveBeenCalled();
      const first = await migratePendingImages('tab', document, `![](${placeholder})`);
      expect(first.markdown).not.toContain('mdplus-image:');
      commitImageMigration(first);
      mocks.invoke.mockClear();
      const next = await migratePendingImages('tab', 'D:\\new\\note.md', first.markdown);
      expect(next.markdown).toMatch(/^!\[\]\(\.\/assets\/image-.+\.png\)$/);
      expect(mocks.invoke).toHaveBeenCalledWith('save_binary_file', expect.objectContaining({
        path: expect.stringContaining('D:\\new\\assets\\image-'), data: [65, 66, 67],
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
