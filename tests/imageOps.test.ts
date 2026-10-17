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
