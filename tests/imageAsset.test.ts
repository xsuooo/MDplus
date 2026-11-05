import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readImageFile: vi.fn(), fileMtime: vi.fn() }));
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
import { clearPendingImages, loadImageReferences, migratePendingImages } from '../src/lib/imageOps';

const files = new Map<string, number[]>();
beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  clearPendingImages('one');
  clearPendingImages('two');
  mocks.fileMtime.mockRejectedValue(new Error('not found'));
  mocks.readImageFile.mockImplementation(async (doc: string, relative: string) => ({
    path: path.win32.join(path.win32.dirname(doc), relative),
    mime: 'image/png',
    data: doc.includes('one') ? [65] : [66],
  }));
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, any>) => {
    if (command === 'create_directory') return;
    if (command === 'save_binary_file') {
      files.set(args.path, args.data);
      return;
    }
    if (command === 'save_image_asset') {
      const directory = path.win32.join(path.win32.dirname(args.docPath), 'assets');
      const extension = path.win32.extname(args.filename);
      const stem = args.filename.slice(0, -extension.length);
      let filename = args.filename;
      for (let attempt = 1; files.has(path.win32.join(directory, filename)); attempt++)
        filename = `${stem}-${attempt}${extension}`;
      const target = path.win32.join(directory, filename);
      files.set(target, args.data);
      return { filename, relativePath: `./assets/${filename}`, path: target };
    }
    throw new Error(`Unexpected image IPC: ${command}`);
  });
});

describe('shared image output directory', () => {
  it('uses independently allocated paths for two tabs with the same image filename', async () => {
    const one = await loadImageReferences('one', '![](./img/pic.png)', 'C:/one/note.md');
    const two = await loadImageReferences('two', '![](./img/pic.png)', 'C:/two/note.md');
    const result = await Promise.all([
      migratePendingImages('one', 'D:/out/one.md', one),
      migratePendingImages('two', 'D:/out/two.md', two),
    ]);
    expect(result[0].references[0].relativePath).not.toBe(result[1].references[0].relativePath);
    expect(files.size).toBe(2);
    expect(files.get(result[0].updates[0].source.absolutePath)).toEqual([65]);
    expect(files.get(result[1].updates[0].source.absolutePath)).toEqual([66]);
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'save_image_asset'),
    ).toHaveLength(2);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'save_binary_file')).toBe(false);
  });

  it('preserves a native allocation error rather than falling back to an overwrite', async () => {
    const markdown = await loadImageReferences('one', '![](./img/pic.png)', 'C:/one/note.md');
    const failure = { code: 'BUSY', message: 'image directory is locked' };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'save_image_asset') throw failure;
    });
    await expect(migratePendingImages('one', 'D:/out/one.md', markdown)).rejects.toBe(failure);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'save_binary_file')).toBe(false);
  });
});
