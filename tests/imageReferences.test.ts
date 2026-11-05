import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readImageFile: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => path.win32.join(...parts),
  dirname: async (file: string) => path.win32.dirname(file),
}));
vi.mock('../src/lib/fileOps', () => ({
  basename: path.win32.basename,
  readImageFile: mocks.readImageFile,
}));

import {
  clearPendingImages,
  commitImageMigration,
  getPendingImages,
  loadImageReferences,
  migratePendingImages,
  prepareImageReferences,
  resolveImageSource,
  restorePendingImages,
  subscribeImageSources,
} from '../src/lib/imageOps';

const document = 'C:\\notes\\note.md';
const markdown = '![photo](./img/pic.png "caption")';
const oldBytes = [65, 66, 67];
const newBytes = [88, 89, 90];
const preview = (bytes: number[]) =>
  `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const loaded = (bytes = oldBytes, relative = 'img/pic.png', doc = document) => ({
  path: path.win32.join(path.win32.dirname(doc), relative),
  mime: 'image/png',
  data: bytes,
});
const tokenFrom = (text: string) => text.match(/mdplus-image:[\w-]+/)![0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  clearPendingImages('image-tx');
  clearPendingImages('other-image-tx');
  vi.clearAllMocks();
  mocks.readImageFile.mockReset();
  mocks.invoke.mockReset();
  mocks.readImageFile.mockImplementation(async (doc: string, relative: string) =>
    loaded(oldBytes, relative, doc),
  );
  let count = 0;
  mocks.invoke.mockImplementation(
    async (command: string, args: { docPath: string; filename: string }) => {
      if (command !== 'save_image_asset') throw new Error(`Unexpected write: ${command}`);
      const filename = `${++count}-${args.filename}`;
      return {
        filename,
        relativePath: `./assets/${filename}`,
        path: path.win32.join(path.win32.dirname(args.docPath), 'assets', filename),
      };
    },
  );
});

describe('transactional image references', () => {
  it('refreshes a repeated raw path while retaining the old compact token for undo', async () => {
    const original = tokenFrom(await loadImageReferences('image-tx', markdown, document));
    mocks.readImageFile.mockResolvedValue(loaded(newBytes));
    await loadImageReferences('image-tx', markdown, document);
    expect(resolveImageSource('image-tx', './img/pic.png')).toBe(preview(newBytes));
    expect(resolveImageSource('image-tx', original)).toBe(preview(oldBytes));
  });

  it('keeps both global cache and source text unchanged until commit', async () => {
    await loadImageReferences('image-tx', markdown, document);
    mocks.readImageFile.mockResolvedValue(loaded(newBytes));
    const prepared = await prepareImageReferences('image-tx', markdown, document, {
      refresh: true,
    });
    expect(prepared.markdown).toBe(markdown);
    expect(resolveImageSource('image-tx', './img/pic.png')).toBe(preview(oldBytes));
    expect(getPendingImages('image-tx')).toHaveLength(1);
    expect(prepared.commit()).toBe(true);
    expect(resolveImageSource('image-tx', './img/pic.png')).toBe(preview(newBytes));
    expect(prepared.commit()).toBe(false);
  });

  it('loads a source-typed new URL without tokenizing the user source', async () => {
    const source = 'Keep ./img/new.png as text.\n\n![new](./img/new.png)';
    const prepared = await prepareImageReferences('image-tx', source, document);
    expect(prepared.markdown).toBe(source);
    expect(resolveImageSource('image-tx', './img/new.png')).toBe('./img/new.png');
    expect(prepared.commit()).toBe(true);
    expect(resolveImageSource('image-tx', './img/new.png')).toBe(preview(oldBytes));
    expect(mocks.readImageFile).toHaveBeenCalledExactlyOnceWith(document, 'img/new.png');
  });

  it('rejects an older preparation after a newer result commits', async () => {
    const gate = deferred<ReturnType<typeof loaded>>();
    mocks.readImageFile.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(loaded(newBytes));
    const older = prepareImageReferences('image-tx', markdown, document, { refresh: true });
    const newer = await prepareImageReferences('image-tx', markdown, document, { refresh: true });
    expect(newer.commit()).toBe(true);
    gate.resolve(loaded(oldBytes));
    expect((await older).commit()).toBe(false);
    expect(resolveImageSource('image-tx', './img/pic.png')).toBe(preview(newBytes));
  });

  it('does not resurrect a closed tab when an image read finishes later', async () => {
    const gate = deferred<ReturnType<typeof loaded>>();
    mocks.readImageFile.mockReturnValueOnce(gate.promise);
    const preparation = prepareImageReferences('image-tx', markdown, document);
    clearPendingImages('image-tx');
    gate.resolve(loaded());
    expect((await preparation).commit()).toBe(false);
    expect(getPendingImages('image-tx')).toEqual([]);
  });

  it('does not overwrite restored/pasted cache state with an in-flight preparation', async () => {
    const gate = deferred<ReturnType<typeof loaded>>();
    mocks.readImageFile.mockReturnValueOnce(gate.promise);
    const preparation = prepareImageReferences('image-tx', markdown, document);
    restorePendingImages('image-tx', [
      {
        placeholder: 'mdplus-image:restored',
        filename: 'restored.png',
        data: newBytes,
        mime: 'image/png',
      },
    ]);
    gate.resolve(loaded());
    expect((await preparation).commit()).toBe(false);
    expect(resolveImageSource('image-tx', 'mdplus-image:restored')).toBe(preview(newBytes));
  });

  it('leaves the old cache intact on a failed preparation, then invalidates only the live alias on commit', async () => {
    const token = tokenFrom(await loadImageReferences('image-tx', markdown, document));
    mocks.readImageFile.mockRejectedValue(new Error('image was removed'));
    const prepared = await prepareImageReferences('image-tx', markdown, document, {
      refresh: true,
    });
    expect(resolveImageSource('image-tx', './img/pic.png')).toBe(preview(oldBytes));
    expect(prepared.commit()).toBe(true);
    expect(resolveImageSource('image-tx', './img/pic.png')).toBe('./img/pic.png');
    expect(resolveImageSource('image-tx', token)).toBe(preview(oldBytes));
    mocks.invoke.mockClear();
    await migratePendingImages('image-tx', 'D:\\other\\note.md', markdown);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('exports old undo tokens from retained bytes instead of reusing the changed source file', async () => {
    const oldToken = tokenFrom(await loadImageReferences('image-tx', markdown, document));
    mocks.readImageFile.mockResolvedValue(loaded(newBytes));
    const prepared = await prepareImageReferences('image-tx', markdown, document, {
      refresh: true,
    });
    expect(prepared.commit()).toBe(true);
    const migration = await migratePendingImages('image-tx', document, `![undo](${oldToken})`);
    expect(mocks.invoke).toHaveBeenCalledWith(
      'save_image_asset',
      expect.objectContaining({ data: oldBytes }),
    );
    expect(migration.markdown).not.toContain('./img/pic.png');
    expect(resolveImageSource('image-tx', oldToken)).toBe(preview(oldBytes));
  });

  it('does not duplicate immutable image bytes when a refresh observes the same content', async () => {
    const oldToken = tokenFrom(await loadImageReferences('image-tx', markdown, document));
    for (let i = 0; i < 3; i += 1) {
      const prepared = await prepareImageReferences('image-tx', markdown, document, {
        refresh: true,
      });
      expect(prepared.commit()).toBe(true);
    }
    expect(getPendingImages('image-tx')).toHaveLength(1);
    expect(resolveImageSource('image-tx', oldToken)).toBe(preview(oldBytes));
  });

  it('invalidates old preparations even if the winning refresh had identical bytes', async () => {
    await loadImageReferences('image-tx', markdown, document);
    const gate = deferred<ReturnType<typeof loaded>>();
    mocks.readImageFile.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(loaded(oldBytes));
    const stale = prepareImageReferences('image-tx', markdown, document, { refresh: true });
    expect(
      (await prepareImageReferences('image-tx', markdown, document, { refresh: true })).commit(),
    ).toBe(true);
    gate.resolve(loaded(newBytes));
    expect((await stale).commit()).toBe(false);
    expect(resolveImageSource('image-tx', './img/pic.png')).toBe(preview(oldBytes));
  });

  it('does not reuse an alias belonging to a different document directory', async () => {
    await loadImageReferences('image-tx', markdown, document);
    const other = 'D:\\different\\note.md';
    mocks.readImageFile.mockResolvedValue(loaded(newBytes, 'img/pic.png', other));
    expect((await prepareImageReferences('image-tx', markdown, other)).commit()).toBe(true);
    expect(mocks.readImageFile).toHaveBeenLastCalledWith(other, 'img/pic.png');
    expect(resolveImageSource('image-tx', './img/pic.png')).toBe(preview(newBytes));
  });

  it('rejects a pending refresh after Save As commits new image sources', async () => {
    await loadImageReferences('image-tx', markdown, document);
    const gate = deferred<ReturnType<typeof loaded>>();
    mocks.readImageFile.mockReturnValueOnce(gate.promise);
    const preparation = prepareImageReferences('image-tx', markdown, document, { refresh: true });
    const migration = await migratePendingImages('image-tx', 'D:\\other\\note.md', markdown);
    commitImageMigration(migration);
    gate.resolve(loaded(newBytes));
    expect((await preparation).commit()).toBe(false);
    expect(resolveImageSource('image-tx', './assets/1-pic.png')).toBe(preview(oldBytes));
  });

  it('notifies only the affected tab and detaches subscribers without leaking callbacks', async () => {
    const update = vi.fn();
    const unsubscribe = subscribeImageSources('image-tx', update);
    await loadImageReferences('other-image-tx', markdown, document);
    expect(update).not.toHaveBeenCalled();
    const prepared = await prepareImageReferences('image-tx', markdown, document);
    expect(update).not.toHaveBeenCalled();
    prepared.commit();
    expect(update).toHaveBeenCalledTimes(1);
    unsubscribe();
    clearPendingImages('image-tx');
    expect(update).toHaveBeenCalledTimes(1);
  });
});
