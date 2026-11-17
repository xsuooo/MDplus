import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => path.win32.join(...parts),
  dirname: async (file: string) => path.win32.dirname(file),
}));

import { RECOVERY_DELAY_MS } from '../src/config/constants';
import {
  capturePendingImages,
  clearPendingImages,
  commitImageMigration,
  finalizeImageMigration,
  loadImageReferences,
  migratePendingImages,
  prepareImageReferences,
  imagePreviewUrl,
  subscribeImageSources,
  unstashedImageCount,
} from '../src/lib/imageOps';
import { getImageUrls } from '../src/lib/imagePaths';
import { prepareRecovery, scheduleSnapshot } from '../src/lib/recovery';
import {
  A,
  B,
  C,
  STASH_FULL,
  base64,
  both,
  createNative,
  fileB,
  notePath,
  one,
  otherPath,
  previewA,
  sha256,
} from './imageStashNative';

let native: ReturnType<typeof createNative>;
let tab: string;
let sequence = 0;
const commands = () => mocks.invoke.mock.calls.map(([command]) => command as string);
const draft = (markdown: string) => ({ id: tab, title: 'note.md', path: notePath, markdown });
const read = (lease: ReturnType<typeof capturePendingImages>) =>
  Promise.all(
    lease.images.map((image) =>
      lease.withDataBase64(image.placeholder, async (dataBase64) => dataBase64),
    ),
  );

/** Image A is cached while there is room; image B is referenced after the stash filled up. */
async function prepareBoth() {
  const first = await prepareImageReferences(tab, one, notePath);
  expect(first.commit()).toBe(true);
  native.state.full = true;
  const second = await prepareImageReferences(tab, both, notePath);
  expect(second.commit()).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  tab = `stash-full-${++sequence}`;
  native = createNative();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(native.invoke);
});

afterEach(() => {
  clearPendingImages(tab);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('a full image stash', () => {
  it('prepares a newly referenced image without admitting it or evicting the existing one', async () => {
    await prepareBoth();

    expect(imagePreviewUrl(tab, './img/a.png')).toBe(previewA);
    expect(imagePreviewUrl(tab, './img/b.png')).toBe('./img/b.png');
    expect(commands()).not.toContain('discard_stashed_images');
    expect([...native.stash.values()]).toEqual([base64(A)]);

    const lease = capturePendingImages(tab, getImageUrls(both));
    try {
      expect(lease.images.map((image) => image.source?.url)).toEqual([
        './img/a.png',
        './img/b.png',
      ]);
      expect(await read(lease)).toEqual([base64(A), base64(B)]);
    } finally {
      lease.release();
    }
    expect(imagePreviewUrl(tab, './img/a.png')).toBe(previewA);
    expect([...native.stash.values()]).toEqual([base64(A)]);
  });

  it('admits the image on a later preparation once the stash has room again', async () => {
    await prepareBoth();
    native.state.full = false;

    const prepared = await prepareImageReferences(tab, both, notePath);
    expect(prepared.commit()).toBe(true);

    expect(imagePreviewUrl(tab, './img/b.png')).toBe('http://mdplus-image-stash.localhost/stash-2');
    expect([...native.stash.values()]).toEqual([base64(A), base64(B)]);
  });

  it('forgets an image left in its file as soon as the text stops referencing it', async () => {
    await prepareBoth();
    expect(unstashedImageCount(tab)).toBe(1);
    const update = vi.fn();
    const unsubscribe = subscribeImageSources(tab, update);

    try {
      const removed = await prepareImageReferences(tab, one, notePath);
      expect(removed.commit()).toBe(true);

      expect(unstashedImageCount(tab)).toBe(0);
      expect(update).toHaveBeenCalledTimes(1);
      expect(imagePreviewUrl(tab, './img/a.png')).toBe(previewA);
      expect(commands()).not.toContain('discard_stashed_images');
      expect([...native.stash.values()]).toEqual([base64(A)]);

      const restored = await prepareImageReferences(tab, both, notePath);
      expect(restored.commit()).toBe(true);

      expect(unstashedImageCount(tab)).toBe(1);
      expect(update).toHaveBeenCalledTimes(2);
      expect(imagePreviewUrl(tab, './img/b.png')).toBe('./img/b.png');
    } finally {
      unsubscribe();
    }
  });

  it('copies nothing for a save to the same path', async () => {
    await prepareBoth();

    const migration = await migratePendingImages(tab, notePath, both);
    expect(migration.markdown).toBe(both);
    commitImageMigration(migration);
    await finalizeImageMigration(migration, 'committed');

    expect(commands()).not.toContain('save_image_asset');
    expect(imagePreviewUrl(tab, './img/a.png')).toBe(previewA);
    const lease = capturePendingImages(tab, getImageUrls(both));
    try {
      expect(await read(lease)).toEqual([base64(A), base64(B)]);
    } finally {
      lease.release();
    }
  });

  it('copies both images for Save As to another directory and discards them when the write does not happen', async () => {
    await prepareBoth();

    const migration = await migratePendingImages(tab, otherPath, both);
    expect(migration.markdown).toBe('![a](./assets/1-a.png)\n\n![b](./assets/2-b.png)');
    expect([...native.assets.values()].map((asset) => asset.dataBase64)).toEqual([
      base64(A),
      base64(B),
    ]);

    await finalizeImageMigration(migration, 'unchanged');
    expect(native.assets.size).toBe(0);
    expect(imagePreviewUrl(tab, './img/a.png')).toBe(previewA);
    const lease = capturePendingImages(tab, getImageUrls(both));
    try {
      expect(await read(lease)).toEqual([base64(A), base64(B)]);
    } finally {
      lease.release();
    }
  });

  it('keeps the copies and forgets the old location after a committed Save As', async () => {
    await prepareBoth();

    const migration = await migratePendingImages(tab, otherPath, both);
    commitImageMigration(migration);
    await finalizeImageMigration(migration, 'committed');

    expect(native.assets.size).toBe(2);
    expect(imagePreviewUrl(tab, './assets/1-a.png')).toBe(previewA);
    const stale = capturePendingImages(tab, ['./img/b.png']);
    expect(stale.images).toEqual([]);
    stale.release();

    const prepared = await prepareImageReferences(tab, migration.markdown, otherPath);
    expect(prepared.commit()).toBe(true);
    const lease = capturePendingImages(tab, getImageUrls(migration.markdown));
    try {
      expect(await read(lease)).toEqual([base64(A), base64(B)]);
    } finally {
      lease.release();
    }
  });

  it('refuses to copy an image that changed on disk after it was prepared', async () => {
    await prepareBoth();
    native.files.set(fileB, C);

    await expect(migratePendingImages(tab, otherPath, both)).rejects.toThrow('已变化');
    expect(native.assets.size).toBe(0);

    const prepared = await prepareImageReferences(tab, both, notePath);
    expect(prepared.commit()).toBe(true);
    const migration = await migratePendingImages(tab, otherPath, both);
    expect([...native.assets.values()].map((asset) => asset.dataBase64)).toEqual([
      base64(A),
      base64(C),
    ]);
    await finalizeImageMigration(migration, 'unchanged');
  });

  it('protects the draft with an owned copy of both images', async () => {
    await prepareBoth();
    const status = vi.fn();

    scheduleSnapshot(draft(both), status);
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS);
    expect(status).toHaveBeenLastCalledWith('protected');

    expect(status.mock.calls).toEqual([['pending'], ['protected']]);
    const snapshot = native.snapshots.at(-1)!;
    expect(snapshot.images).toHaveLength(2);
    const [a, b] = snapshot.images;
    expect(snapshot.markdown).toBe(`![a](${a.placeholder})\n\n![b](${b.placeholder})`);
    expect(mocks.invoke).toHaveBeenCalledWith('cache_recovery_image', {
      id: tab,
      key: a.key,
      stashKey: 'stash-1',
      retainedKeys: expect.arrayContaining([a.key, b.key]),
    });
    expect(mocks.invoke).toHaveBeenCalledWith('cache_recovery_document_image', {
      id: tab,
      key: b.key,
      docPath: notePath,
      relativePath: 'img/b.png',
      digest: sha256(B),
      retainedKeys: expect.arrayContaining([a.key, b.key]),
    });
    expect(native.recovery.get(`${tab}/${a.key}`)).toBe(base64(A));
    expect(native.recovery.get(`${tab}/${b.key}`)).toBe(base64(B));
  });

  it('restores both images from the snapshot after the source files are gone', async () => {
    await prepareBoth();
    const status = vi.fn();
    scheduleSnapshot(draft(both), status);
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS);
    expect(status).toHaveBeenLastCalledWith('protected');
    const snapshot = native.snapshots.at(-1)!;

    clearPendingImages(tab);
    native.files.clear();
    native.state.full = false;
    const restored = await prepareRecovery(tab);
    expect(restored.commit()).toBe(true);
    await restored.dispose();

    expect(restored.snapshot.markdown).toBe(snapshot.markdown);
    const lease = capturePendingImages(tab, getImageUrls(restored.snapshot.markdown));
    try {
      expect(await read(lease)).toEqual([base64(A), base64(B)]);
    } finally {
      lease.release();
    }
  });

  it('reports an error instead of protecting bytes that changed after preparation', async () => {
    await prepareBoth();
    native.files.set(fileB, C);
    const status = vi.fn();

    scheduleSnapshot(draft(both), status);
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS);
    expect(status).toHaveBeenLastCalledWith('error');
    expect(native.snapshots).toEqual([]);

    const prepared = await prepareImageReferences(tab, both, notePath);
    expect(prepared.commit()).toBe(true);
    const retry = vi.fn();
    scheduleSnapshot(draft(both), retry);
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS);
    expect(retry).toHaveBeenLastCalledWith('protected');
    const [, b] = native.snapshots.at(-1)!.images;
    expect(native.recovery.get(`${tab}/${b.key}`)).toBe(base64(C));
  });
});

describe('boundaries that stay strict when the stash is full', () => {
  it('rejects the preparation when the stash fails for any other reason', async () => {
    const first = await prepareImageReferences(tab, one, notePath);
    expect(first.commit()).toBe(true);

    native.state.stashFailure = { code: 'IO_ERROR', message: 'Access is denied.' };
    await expect(prepareImageReferences(tab, both, notePath)).rejects.toMatchObject({
      message: 'Access is denied.',
    });
    native.state.stashFailure = 'session image lock failed';
    await expect(prepareImageReferences(tab, both, notePath)).rejects.toBe(
      'session image lock failed',
    );

    expect(imagePreviewUrl(tab, './img/a.png')).toBe(previewA);
    expect(imagePreviewUrl(tab, './img/b.png')).toBe('./img/b.png');
    const lease = capturePendingImages(tab, getImageUrls(both));
    expect(lease.images.map((image) => image.source?.url)).toEqual(['./img/a.png']);
    lease.release();
  });

  it('rejects a refresh, which must never leave a changed file showing old bytes', async () => {
    const first = await prepareImageReferences(tab, one, notePath);
    expect(first.commit()).toBe(true);
    native.state.full = true;

    await expect(
      prepareImageReferences(tab, both, notePath, { refresh: true }),
    ).rejects.toMatchObject({ message: STASH_FULL.message });
    await expect(loadImageReferences(tab, both, notePath)).rejects.toMatchObject({
      message: STASH_FULL.message,
    });

    expect(imagePreviewUrl(tab, './img/a.png')).toBe(previewA);
    expect([...native.stash.values()]).toEqual([base64(A)]);
    const lease = capturePendingImages(tab, getImageUrls(both));
    expect(lease.images.map((image) => image.source?.url)).toEqual(['./img/a.png']);
    lease.release();
  });

  it('still refuses a draft whose relative image was never prepared', async () => {
    const status = vi.fn();

    scheduleSnapshot(draft(both), status);
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS);
    expect(status).toHaveBeenLastCalledWith('error');

    expect(native.snapshots).toEqual([]);
    expect(commands()).toEqual([]);
  });
});
