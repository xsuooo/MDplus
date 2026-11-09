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
  stagePendingImages,
  subscribeImageSources,
} from '../src/lib/imageOps';

const document = 'C:\\notes\\note.md';
const markdown = '![photo](./img/pic.png "caption")';
const oldBytes = [65, 66, 67];
const newBytes = [88, 89, 90];
const preview = (bytes: number[]) =>
  `http://mdplus-image-stash.localhost/${Buffer.from(bytes).toString('base64')}`;
const loaded = (bytes = oldBytes, relative = 'img/pic.png', doc = document) => ({
  path: path.win32.join(path.win32.dirname(doc), relative),
  mime: 'image/png',
  dataBase64: Buffer.from(bytes).toString('base64'),
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
    async (
      command: string,
      args: { docPath: string; filename: string; dataBase64: string; key: string },
    ) => {
      if (command === 'stash_image')
        return {
          key: args.dataBase64,
          mime: 'image/png',
          previewUrl: `http://mdplus-image-stash.localhost/${args.dataBase64}`,
        };
      if (command === 'read_stashed_image') return { mime: 'image/png', dataBase64: args.key };
      if (
        command === 'discard_stashed_images' ||
        command === 'commit_image_assets' ||
        command === 'discard_image_assets'
      )
        return;
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

  it.each([
    ['my%20photo.png', 'my photo.png'],
    ['100%25.png', '100%.png'],
    ['100%2520.png', '100%20.png'],
    ['photo%23one.png', 'photo#one.png'],
    ['%E5%9B%BE%E7%89%87.png', '图片.png'],
  ])('loads encoded image URL %s without changing its source identity', async (url, filename) => {
    const source = `![photo](./img/${url})`;
    mocks.readImageFile.mockImplementation(async (doc: string, relative: string) => {
      if (relative !== `img/${filename}`) throw new Error('image file not found');
      return loaded(oldBytes, relative, doc);
    });
    const prepared = await prepareImageReferences('image-tx', source, document);
    expect(prepared.markdown).toBe(source);
    expect(prepared.commit()).toBe(true);
    expect(mocks.readImageFile).toHaveBeenCalledExactlyOnceWith(document, `img/${filename}`);
    expect(resolveImageSource('image-tx', `./img/${url}`)).toBe(preview(oldBytes));

    const saved = await migratePendingImages('image-tx', document, source);
    expect(saved.markdown).toBe(source);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'save_image_asset')).toBe(false);
    commitImageMigration(saved);

    const savedAs = await migratePendingImages('image-tx', 'D:\\other\\note.md', source);
    expect(savedAs.updates[0].filename).toBe(`1-${filename}`);
    commitImageMigration(savedAs);
    mocks.readImageFile.mockClear();
    mocks.readImageFile.mockImplementation(async (doc: string, relative: string) => {
      if (relative !== `assets/1-${filename}`) throw new Error('image file not found');
      return loaded(oldBytes, relative, doc);
    });
    const reopened = await prepareImageReferences(
      'other-image-tx',
      savedAs.markdown,
      'D:\\other\\note.md',
    );
    expect(reopened.commit()).toBe(true);
    expect(mocks.readImageFile).toHaveBeenCalledExactlyOnceWith(
      'D:\\other\\note.md',
      `assets/1-${filename}`,
    );
    expect(resolveImageSource('other-image-tx', savedAs.references[0].relativePath)).toBe(
      preview(oldBytes),
    );
  });

  it.each(['100%.png', 'photo%2.png'])(
    'retains support for a legacy filename with a malformed percent escape: %s',
    async (filename) => {
      const source = `![photo](./img/${filename})`;
      const prepared = await prepareImageReferences('image-tx', source, document);
      expect(prepared.commit()).toBe(true);
      expect(mocks.readImageFile).toHaveBeenCalledExactlyOnceWith(document, `img/${filename}`);
      expect(resolveImageSource('image-tx', `./img/${filename}`)).toBe(preview(oldBytes));
    },
  );

  it.each([
    ['%2e%2e/private.png', '../private.png'],
    ['%2Fprivate.png', '/private.png'],
    ['C%3A%5Cprivate.png', 'C:\\private.png'],
  ])('lets native validation reject decoded unsafe URL %s', async (url, relative) => {
    mocks.readImageFile.mockRejectedValue(new Error('image path outside document directory'));
    const source = `![photo](${url})`;
    const prepared = await prepareImageReferences('image-tx', source, document);
    expect(prepared.commit()).toBe(true);
    expect(prepared.markdown).toBe(source);
    expect(mocks.readImageFile).toHaveBeenCalledExactlyOnceWith(document, relative);
    expect(getPendingImages('image-tx')).toEqual([]);
  });

  it('rejects an older preparation after a newer result commits', async () => {
    const gate = deferred<ReturnType<typeof loaded>>();
    mocks.readImageFile.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(loaded(newBytes));
    const older = prepareImageReferences('image-tx', markdown, document, { refresh: true });
    const pendingNewer = prepareImageReferences('image-tx', markdown, document, { refresh: true });
    gate.resolve(loaded(oldBytes));
    const newer = await pendingNewer;
    expect(newer.commit()).toBe(true);
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
    const restored = await stagePendingImages([
      {
        placeholder: 'mdplus-image:restored',
        filename: 'restored.png',
        dataBase64: Buffer.from(newBytes).toString('base64'),
        mime: 'image/png',
      },
    ]);
    const gate = deferred<ReturnType<typeof loaded>>();
    mocks.readImageFile.mockReturnValueOnce(gate.promise);
    const preparation = prepareImageReferences('image-tx', markdown, document);
    restorePendingImages('image-tx', restored);
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
      expect.objectContaining({ dataBase64: Buffer.from(oldBytes).toString('base64') }),
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
    const winning = prepareImageReferences('image-tx', markdown, document, { refresh: true });
    gate.resolve(loaded(newBytes));
    expect((await winning).commit()).toBe(true);
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
    gate.resolve(loaded(newBytes));
    const migration = await migratePendingImages('image-tx', 'D:\\other\\note.md', markdown);
    commitImageMigration(migration);
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
