import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => path.win32.join(...parts),
  dirname: async (file: string) => path.win32.dirname(file),
}));

import {
  cancelImageInsertion,
  capturePendingImages,
  clearPendingImages,
  commitImageMigration,
  finalizeImageMigration,
  getPendingImages,
  importDroppedImage,
  migratePendingImages,
  resolveImageSource,
  settleImageInsertion,
} from '../src/lib/imageOps';

const key = 'a'.repeat(32);
const receipt = {
  key,
  mime: 'image/png',
  filename: '图片 1.png',
  previewUrl: `http://mdplus-image-stash.localhost/${key}`,
  byteLength: 1,
  digest: 'b'.repeat(64),
};

beforeEach(() => {
  clearPendingImages('drop-tab');
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === 'import_dropped_image') return { ...receipt };
    if (command === 'read_stashed_image') return { mime: receipt.mime, dataBase64: 'QQ==' };
    if (command === 'save_image_asset')
      return {
        filename: args.filename,
        relativePath: `./assets/${args.filename}`,
        path: path.win32.join(path.win32.dirname(args.docPath), 'assets', args.filename),
        allocationId: 'allocation',
      };
  });
});
afterEach(() => clearPendingImages('drop-tab'));

describe('native drop images reuse immutable backing and migration ownership', () => {
  it('pins and serializes native stash copies without reading image bytes into JavaScript', async () => {
    const token = await importDroppedImage('C:/original/a.png', 'drop-tab');
    const lease = capturePendingImages('drop-tab', [token]);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const copy = vi.fn(async () => gate);
    const pending = lease.withStashKey(token, copy);
    lease.release();
    await cancelImageInsertion('drop-tab', token);
    await vi.waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith(key));
    expect(native.invoke.mock.calls.some(([command]) => command === 'read_stashed_image')).toBe(
      false,
    );
    expect(native.invoke).not.toHaveBeenCalledWith('discard_stashed_images', { keys: [key] });
    const next = importDroppedImage('C:/original/b.png', 'drop-tab');
    await Promise.resolve();
    expect(
      native.invoke.mock.calls.filter(([command]) => command === 'import_dropped_image'),
    ).toHaveLength(1);
    finish();
    await pending;
    await next;
    expect(native.invoke).toHaveBeenCalledWith('discard_stashed_images', { keys: [key] });
    await expect(lease.withStashKey(token, copy)).rejects.toThrow('租约已释放');
  });

  it('keeps compact metadata before first save and migrates unchanged bytes to relative assets', async () => {
    const token = await importDroppedImage('C:/original/图片 1.png', 'drop-tab');
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('import_dropped_image', {
      path: 'C:/original/图片 1.png',
    });
    expect(getPendingImages('drop-tab')).toEqual([
      expect.objectContaining({ placeholder: token, filename: receipt.filename, byteLength: 1 }),
    ]);
    expect(resolveImageSource('drop-tab', token)).toBe(receipt.previewUrl);
    settleImageInsertion('drop-tab', token);
    const markdown = `before ![](${token}) after`;
    const migration = await migratePendingImages('drop-tab', 'D:/saved/note.md', markdown);
    expect(migration.markdown).toBe('before ![](<./assets/图片 1.png>) after');
    expect(native.invoke).toHaveBeenCalledWith('save_image_asset', {
      docPath: 'D:/saved/note.md',
      filename: receipt.filename,
      dataBase64: 'QQ==',
    });
    commitImageMigration(migration);
    await finalizeImageMigration(migration, 'committed');
    expect(native.invoke).toHaveBeenCalledWith('commit_image_assets', {
      allocationIds: ['allocation'],
    });
    expect(resolveImageSource('drop-tab', './assets/图片 1.png')).toBe(receipt.previewUrl);
  });

  it('cancels a failed insertion immediately but retains an independent running read lease', async () => {
    const token = await importDroppedImage('C:/original/a.png', 'drop-tab');
    const lease = capturePendingImages('drop-tab', [token]);
    await cancelImageInsertion('drop-tab', token);
    expect(getPendingImages('drop-tab')).toEqual([]);
    expect(native.invoke).not.toHaveBeenCalledWith('discard_stashed_images', { keys: [key] });
    expect(await lease.readDataBase64(token)).toBe('QQ==');
    lease.release();
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith('discard_stashed_images', { keys: [key] }),
    );
  });

  it('discards a delayed imported stash after its original tab cache is cleared', async () => {
    let finish!: (value: typeof receipt) => void;
    const gate = new Promise<typeof receipt>((resolve) => (finish = resolve));
    native.invoke.mockImplementation(async (command: string) =>
      command === 'import_dropped_image' ? gate : undefined,
    );
    const pending = importDroppedImage('C:/original/a.png', 'drop-tab');
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith('import_dropped_image', expect.anything()),
    );
    clearPendingImages('drop-tab');
    finish(receipt);
    await expect(pending).rejects.toThrow('标签已关闭');
    expect(getPendingImages('drop-tab')).toEqual([]);
    expect(native.invoke).toHaveBeenCalledWith('discard_stashed_images', { keys: [key] });
  });

  it('rejects an empty receipt and releases its native key without publishing a URL', async () => {
    native.invoke.mockImplementation(async (command: string) =>
      command === 'import_dropped_image' ? { ...receipt, byteLength: 0 } : undefined,
    );
    await expect(importDroppedImage('C:/original/a.png', 'drop-tab')).rejects.toThrow('结果无效');
    expect(getPendingImages('drop-tab')).toEqual([]);
    expect(native.invoke).toHaveBeenCalledWith('discard_stashed_images', { keys: [key] });
  });
});
