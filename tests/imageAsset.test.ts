import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../src/config/constants';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readImageFile: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => path.win32.join(...parts),
  dirname: async (file: string) => path.win32.dirname(file),
}));
vi.mock('../src/lib/fileOps', () => ({
  basename: (file: string) => path.win32.basename(file),
  readImageFile: mocks.readImageFile,
}));
import {
  capturePendingImages,
  clearPendingImages,
  collectUnusedImages,
  commitImageMigration,
  finalizeImageMigration,
  getPendingImages,
  getInFlightImages,
  imageCacheUsage,
  loadImageReferences,
  migratePendingImages,
  prepareImageReferences,
  registerImageReachability,
  resolveImageSource,
  restorePendingImages,
  saveImage,
  settleImageInsertion,
  stagePendingImages,
} from '../src/lib/imageOps';

interface DiskAsset {
  dataBase64: string;
}
const files = new Map<string, DiskAsset>();
const allocations = new Map<string, { path: string; asset: DiskAsset }>();
const stashes = new Map<string, string>();
let sequence = 0;
let assetWrites = 0;
let failAssetAt = 0;
let maxStashBytes = Infinity;
const native = async (command: string, args: Record<string, any>) => {
  if (command === 'stash_image') {
    const total = [...stashes.values()].reduce(
      (sum, data) => sum + Buffer.from(data, 'base64').length,
      0,
    );
    if (total + Buffer.from(args.dataBase64, 'base64').length > maxStashBytes)
      throw new Error('image stash budget exhausted');
    const key = `stash-${++sequence}`;
    stashes.set(key, args.dataBase64);
    return { key, mime: 'image/png', previewUrl: `http://mdplus-image-stash.localhost/${key}` };
  }
  if (command === 'read_stashed_image') {
    if (!stashes.has(args.key)) throw new Error('stash missing');
    return { mime: 'image/png', dataBase64: stashes.get(args.key) };
  }
  if (command === 'discard_stashed_images') {
    for (const key of args.keys) stashes.delete(key);
    return;
  }
  if (command === 'save_image_asset') {
    if (++assetWrites === failAssetAt) throw new Error('disk full on second image');
    const directory = path.win32.join(path.win32.dirname(args.docPath), 'assets');
    const extension = path.win32.extname(args.filename);
    const stem = args.filename.slice(0, -extension.length);
    let filename = args.filename;
    for (let attempt = 1; ; attempt++) {
      const target = path.win32.join(directory, filename);
      const existing = files.get(target);
      if (!existing) {
        const asset = { dataBase64: args.dataBase64 };
        const allocationId = `allocation-${++sequence}`;
        files.set(target, asset);
        allocations.set(allocationId, { path: target, asset });
        return { filename, relativePath: `./assets/${filename}`, path: target, allocationId };
      }
      if (
        existing.dataBase64 === args.dataBase64 &&
        ![...allocations.values()].some((owner) => owner.path === target)
      )
        return { filename, relativePath: `./assets/${filename}`, path: target, allocationId: null };
      filename = `${stem}-${attempt}${extension}`;
    }
  }
  if (command === 'commit_image_assets' || command === 'discard_image_assets') {
    for (const id of args.allocationIds) {
      const owned = allocations.get(id);
      if (!owned) continue;
      if (command === 'discard_image_assets' && files.get(owned.path) === owned.asset)
        files.delete(owned.path);
      allocations.delete(id);
    }
    return;
  }
  throw new Error(`Unexpected image IPC: ${command}`);
};
beforeEach(() => {
  clearPendingImages('one');
  clearPendingImages('two');
  vi.clearAllMocks();
  files.clear();
  allocations.clear();
  stashes.clear();
  sequence = assetWrites = failAssetAt = 0;
  maxStashBytes = Infinity;
  mocks.readImageFile.mockImplementation(async (doc: string, relative: string) => ({
    path: path.win32.join(path.win32.dirname(doc), relative),
    mime: 'image/png',
    dataBase64: Buffer.from(doc.includes('one') ? 'A' : 'B').toString('base64'),
  }));
  mocks.invoke.mockImplementation(native);
});
const load = (markdown = '![](./img/pic.png)') =>
  loadImageReferences('one', markdown, 'C:/one/note.md');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('owned image output transactions', () => {
  it('allocates independently for two tabs using the same output filename', async () => {
    const one = await load();
    const two = await loadImageReferences('two', '![](./img/pic.png)', 'C:/two/note.md');
    const result = await Promise.all([
      migratePendingImages('one', 'D:/out/one.md', one),
      migratePendingImages('two', 'D:/out/two.md', two),
    ]);
    expect(result[0].references[0].relativePath).not.toBe(result[1].references[0].relativePath);
    expect(files.size).toBe(2);
    expect(files.get(result[0].updates[0].source.absolutePath)?.dataBase64).toBe('QQ==');
    expect(files.get(result[1].updates[0].source.absolutePath)?.dataBase64).toBe('Qg==');
    for (const migration of result) await finalizeImageMigration(migration, 'committed');
    expect(allocations.size).toBe(0);
  });

  it('rolls back earlier allocations when the second image fails, so retry does not duplicate files', async () => {
    const text = await load('![](./img/one.png)\n![](./img/two.png)');
    failAssetAt = 2;
    await expect(migratePendingImages('one', 'D:/out/note.md', text)).rejects.toThrow('disk full');
    expect(files.size).toBe(0);
    expect(allocations.size).toBe(0);
    expect(getPendingImages('one').every((image) => image.source?.url.startsWith('./img/'))).toBe(
      true,
    );
    const retry = await migratePendingImages('one', 'D:/out/note.md', text);
    expect(retry.markdown).toBe('![](./assets/one.png)\n![](./assets/two.png)');
    await finalizeImageMigration(retry, 'unchanged');
    expect(files.size).toBe(0);
  });

  it('discards provisional allocations after a document conflict/cancel, idempotently', async () => {
    const migration = await migratePendingImages('one', 'D:/out/note.md', await load());
    expect(files.size).toBe(1);
    await finalizeImageMigration(migration, 'unchanged');
    await finalizeImageMigration(migration, 'unchanged');
    expect(files.size).toBe(0);
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'discard_image_assets'),
    ).toHaveLength(1);
    expect(getPendingImages('one')).toHaveLength(1);
  });

  it.each(['committed', 'unknown'] as const)(
    'never deletes resources after a %s document outcome',
    async (state) => {
      const migration = await migratePendingImages('one', 'D:/out/note.md', await load());
      await finalizeImageMigration(migration, state);
      await finalizeImageMigration(migration, 'unchanged');
      expect(files.size).toBe(1);
      expect(allocations.size).toBe(0);
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'discard_image_assets')).toBe(
        false,
      );
    },
  );

  it('does not acquire deletion rights over a reused committed asset', async () => {
    const text = await load();
    const first = await migratePendingImages('one', 'D:/out/note.md', text);
    await finalizeImageMigration(first, 'committed');
    const retry = await migratePendingImages('one', 'D:/out/note.md', text);
    expect(retry.allocationIds).toEqual([]);
    await finalizeImageMigration(retry, 'unchanged');
    expect(files.size).toBe(1);
  });

  it('passes only opaque allocation ids to discard, never a path that might now be somebody else’s file', async () => {
    const migration = await migratePendingImages('one', 'D:/out/note.md', await load());
    const savedPath = migration.updates[0].source.absolutePath;
    files.set(savedPath, { dataBase64: 'cmVwbGFjZWQ=' });
    const ids = [...migration.allocationIds];
    await finalizeImageMigration(migration, 'unchanged');
    expect(files.get(savedPath)?.dataBase64).toBe('cmVwbGFjZWQ=');
    expect(mocks.invoke).toHaveBeenCalledWith('discard_image_assets', { allocationIds: ids });
  });
});

describe('disk-backed bounded image cache', () => {
  it('retains metadata and stable preview URLs, not number arrays, base64 or DataURL copies', async () => {
    const text = await load();
    const image = getPendingImages('one')[0];
    expect(image).toMatchObject({ byteLength: 1, mime: 'image/png' });
    expect(image).not.toHaveProperty('data');
    expect(image).not.toHaveProperty('dataBase64');
    expect(image).not.toHaveProperty('preview');
    expect(resolveImageSource('one', image.placeholder)).toMatch(
      /^http:\/\/mdplus-image-stash\.localhost\//,
    );
    expect(imageCacheUsage().residentBytes).toBe(0);
    const lease = capturePendingImages('one', [image.placeholder]);
    expect(await lease.readDataBase64(image.placeholder)).toBe('QQ==');
    lease.release();
    expect(text).toContain(image.placeholder);
  });

  it('skips reachability roots when the tab has no cached images', async () => {
    const prepared = await prepareImageReferences('one', 'plain text', 'C:/docs/note.md');
    expect(prepared.commit()).toBe(true);
    const root = vi.fn(() => []);
    const unregister = registerImageReachability('one', root);

    await collectUnusedImages('one');

    expect(root).not.toHaveBeenCalled();
    unregister();
  });

  it('keeps current/undo/redo roots, then reclaims bytes only after all roots drop them', async () => {
    await load();
    const token = getPendingImages('one')[0].placeholder;
    const history = new Set([token]);
    const unregister = registerImageReachability('one', () => history);
    try {
      const migration = await migratePendingImages('one', 'D:/out/note.md', 'image removed');
      expect(migration.references).toEqual([]);
      expect(migration.historyReferences).toEqual([
        { placeholder: './img/pic.png', relativePath: token },
      ]);
      commitImageMigration(migration);
      await finalizeImageMigration(migration, 'committed');
      await collectUnusedImages('one');
      expect(stashes.size).toBe(1);
      expect(resolveImageSource('one', token)).toContain('mdplus-image-stash.localhost');
      history.clear();
      await collectUnusedImages('one');
      expect(stashes.size).toBe(0);
      expect(getPendingImages('one')).toEqual([]);
    } finally {
      unregister();
    }
  });

  it('pins migration metadata and bytes until the document outcome is finalized', async () => {
    const text = await load();
    const migration = await migratePendingImages('one', 'D:/out/note.md', text);
    const unregister = registerImageReachability('one', () => []);
    try {
      await collectUnusedImages('one');
      expect(getPendingImages('one')).toHaveLength(1);
      await finalizeImageMigration(migration, 'unchanged');
      await collectUnusedImages('one');
      expect(stashes.size).toBe(0);
    } finally {
      unregister();
    }
  });

  it('keeps a recovery/export capture readable after close and releases it at the lease boundary', async () => {
    await load();
    const lease = capturePendingImages('one');
    clearPendingImages('one');
    expect(stashes.size).toBe(1);
    expect(await lease.readDataBase64(lease.images[0].placeholder)).toBe('QQ==');
    lease.release();
    lease.release();
    expect(stashes.size).toBe(0);
    await expect(lease.readDataBase64(lease.images[0].placeholder)).rejects.toThrow('租约已释放');
  });

  it('serializes whole read/consume operations across tabs and pins already queued work when cancelled', async () => {
    await load();
    await loadImageReferences('two', '![](./img/pic.png)', 'C:/two/note.md');
    const one = capturePendingImages('one');
    const two = capturePendingImages('two');
    const gate = deferred<void>();
    const started = deferred<void>();
    const first = one.withDataBase64(one.images[0].placeholder, async (data) => {
      started.resolve();
      await gate.promise;
      return data;
    });
    await started.promise;
    const second = two.readDataBase64(two.images[0].placeholder);
    one.release();
    two.release();
    clearPendingImages('one');
    clearPendingImages('two');
    await Promise.resolve();
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'read_stashed_image'),
    ).toHaveLength(1);
    expect(stashes.size).toBe(2);
    gate.resolve();
    expect(await first).toBe('QQ==');
    expect(await second).toBe('Qg==');
    expect(stashes.size).toBe(0);
  });

  it('rejects new data when the native total budget is full without evicting an undo root', async () => {
    await load();
    const token = getPendingImages('one')[0].placeholder;
    const unregister = registerImageReachability('one', () => [token]);
    try {
      maxStashBytes = 1;
      await expect(saveImage(new Blob(['B'], { type: 'image/png' }), 'one')).rejects.toThrow(
        'budget',
      );
      expect(getPendingImages('one')).toHaveLength(1);
      const lease = capturePendingImages('one');
      expect(await lease.readDataBase64(token)).toBe('QQ==');
      lease.release();
    } finally {
      unregister();
    }
  });

  it('pins recovery duplicates only during insertion or a capture lease, preserving independent undo bytes', async () => {
    const token = await saveImage(new Blob(['A'], { type: 'image/png' }), 'one');
    expect(getInFlightImages('one').map((image) => image.placeholder)).toEqual([token]);
    settleImageInsertion('one', token);
    expect(getInFlightImages('one')).toEqual([]);
    const lease = capturePendingImages('one', [token]);
    expect(getInFlightImages('one').map((image) => image.placeholder)).toEqual([token]);
    expect(await lease.readDataBase64(token)).toBe('QQ==');
    lease.release();
    expect(getInFlightImages('one')).toEqual([]);
    expect(getPendingImages('one').map((image) => image.placeholder)).toEqual([token]);
    expect(stashes.size).toBe(1);
  });

  it('does not reduce the advertised 64 MiB single-image admission limit', async () => {
    const unreadable = new Error('test reached byte reader');
    const arrayBuffer = vi.fn().mockRejectedValue(unreadable);
    const exact = { size: 64 * 1024 * 1024, type: 'image/png', arrayBuffer } as unknown as Blob;
    expect(LIMITS.imageFileBytes).toBe(exact.size);
    expect(LIMITS.imageMemoryBytes).toBeGreaterThanOrEqual(exact.size * 2);
    await expect(saveImage(exact, 'one')).rejects.toBe(unreadable);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    arrayBuffer.mockClear();
    await expect(saveImage({ ...exact, size: exact.size + 1 } as Blob, 'one')).rejects.toThrow(
      '64 MiB',
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('stages recovery atomically and frees partial stages without replacing a live cache', async () => {
    await load();
    const previous = getPendingImages('one')[0];
    maxStashBytes = 2;
    const image = {
      placeholder: 'mdplus-image:restored',
      filename: 'restored.png',
      dataBase64: 'Qg==',
      mime: 'image/png',
    };
    await expect(
      stagePendingImages([image, { ...image, placeholder: 'mdplus-image:second' }]),
    ).rejects.toThrow('budget');
    expect(getPendingImages('one')).toEqual([previous]);
    expect(stashes.size).toBe(1);
    const stage = await stagePendingImages([image]);
    expect(restorePendingImages('one', stage)).toBeUndefined();
    await stage.dispose();
    expect(getPendingImages('one')[0].placeholder).toBe(image.placeholder);
    expect(stashes.size).toBe(1);
  });

  it('invalidates a staged read when GC changes the cache and reclaims rejected preparation bytes', async () => {
    const text = await load();
    const original = getPendingImages('one')[0].placeholder;
    const gate = deferred<{ path: string; mime: string; dataBase64: string }>();
    mocks.readImageFile.mockReturnValueOnce(gate.promise);
    const roots = new Set([original]);
    const unregister = registerImageReachability('one', () => roots);
    try {
      const pending = prepareImageReferences('one', '![](./img/new.png)', 'C:/one/note.md');
      await vi.waitFor(() => expect(mocks.readImageFile).toHaveBeenCalledTimes(2));
      roots.clear();
      await collectUnusedImages('one');
      gate.resolve({ path: 'C:/one/img/new.png', mime: 'image/png', dataBase64: 'Qg==' });
      const prepared = await pending;
      expect(prepared.commit()).toBe(false);
      await prepared.dispose();
      expect(stashes.size).toBe(0);
      expect(text).toContain(original);
    } finally {
      unregister();
    }
  });

  it('settles a cancelled paste before GC and never resurrects a tab closed during its stash write', async () => {
    const token = await saveImage(new Blob(['A'], { type: 'image/png' }), 'one');
    const unregister = registerImageReachability('one', () => []);
    try {
      await collectUnusedImages('one');
      expect(stashes.size).toBe(1);
      settleImageInsertion('one', token);
      await collectUnusedImages('one');
      expect(stashes.size).toBe(0);
      const gate = deferred<ArrayBuffer>();
      const saving = saveImage(
        { size: 1, type: 'image/png', arrayBuffer: () => gate.promise } as Blob,
        'one',
      );
      clearPendingImages('one');
      gate.resolve(new Uint8Array([65]).buffer);
      await expect(saving).rejects.toThrow('标签已关闭');
      expect(getPendingImages('one')).toEqual([]);
      expect(stashes.size).toBe(0);
    } finally {
      unregister();
    }
  });
});
