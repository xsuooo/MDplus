import { describe, expect, it, vi } from 'vitest';
import {
  isDroppedImagePath,
  physicalToClientPosition,
  runImageDrop,
  sortDroppedImages,
  trackSourcePosition,
  type CapturedImageDrop,
  type ImageDropOperations,
  type ImageDropReason,
} from '../src/lib/imageDrop';
import {
  mapSourceEditOffset,
  prepareSourceEdits,
  publishSourceEditorChange,
  type SourceEditorApi,
  type SourceTextEdit,
} from '../src/lib/sourceEditorApi';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture() {
  let reason: ImageDropReason | undefined;
  const target: CapturedImageDrop = {
    tabId: 'original-tab',
    invalidReason: () => reason,
    insert: vi.fn(() => true),
    release: vi.fn(),
  };
  const operations: ImageDropOperations = {
    importImage: vi.fn(async (path) => `token:${path}`),
    protectImage: vi.fn(async () => {}),
    cancelImage: vi.fn(async () => {}),
    settleImage: vi.fn(),
  };
  return { target, operations, invalidate: (next: ImageDropReason) => (reason = next) };
}

describe('image drop batch boundaries', () => {
  it('sorts by natural filename order independently of containing directories', () => {
    expect(sortDroppedImages(['C:/a/10.PNG', 'Z:/b/2.jpg', 'D:/c/1.png'])).toEqual([
      'D:/c/1.png',
      'Z:/b/2.jpg',
      'C:/a/10.PNG',
    ]);
    expect(isDroppedImagePath('C:\\图片 中文\\1.JPEG')).toBe(true);
    expect(isDroppedImagePath('C:/picture.svg')).toBe(false);
    expect(isDroppedImagePath('C:/picture.png.exe')).toBe(false);
  });

  it('converts physical pixels once and rejects non-finite drop coordinates', () => {
    expect(physicalToClientPosition({ x: 300, y: 180 }, 1.5)).toEqual({ x: 200, y: 120 });
    expect(physicalToClientPosition({ x: 400, y: 240 }, 2)).toEqual({ x: 200, y: 120 });
    expect(physicalToClientPosition({ x: 20, y: 30 }, 0)).toEqual({ x: 20, y: 30 });
    expect(physicalToClientPosition({ x: NaN, y: 30 }, 2)).toBeNull();
  });

  it('waits for every native import and recovery protection before one ordered insertion', async () => {
    const f = fixture();
    const gate = deferred<void>();
    const progress = vi.fn();
    vi.mocked(f.operations.protectImage).mockImplementationOnce(() => gate.promise);
    const pending = runImageDrop(['10.png', '2.jpg', '1.png'], f.target, f.operations, progress);
    await vi.waitFor(() => expect(f.operations.protectImage).toHaveBeenCalledTimes(1));
    expect(f.target.insert).not.toHaveBeenCalled();
    expect(f.operations.importImage).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledExactlyOnceWith({ completed: 0, total: 3 });
    gate.resolve();
    expect(await pending).toMatchObject({ attempted: 3, inserted: 3, failures: [] });
    expect(f.operations.importImage).toHaveBeenNthCalledWith(1, '1.png', 'original-tab');
    expect(f.operations.importImage).toHaveBeenNthCalledWith(2, '2.jpg', 'original-tab');
    expect(f.operations.importImage).toHaveBeenNthCalledWith(3, '10.png', 'original-tab');
    expect(f.target.insert).toHaveBeenCalledExactlyOnceWith([
      'token:1.png',
      'token:2.jpg',
      'token:10.png',
    ]);
    expect(f.operations.settleImage).toHaveBeenCalledTimes(3);
    expect(f.target.release).toHaveBeenCalledOnce();
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { completed: 0, total: 3 },
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
  });

  it('keeps successful images after import/protection failures and releases only failed images', async () => {
    const f = fixture();
    vi.mocked(f.operations.importImage).mockImplementation(async (path) => {
      if (path === '2.png') throw new Error('corrupt image');
      return `token:${path}`;
    });
    vi.mocked(f.operations.protectImage).mockImplementation(async (_tab, token) => {
      if (token === 'token:3.jpg') throw new Error('recovery full');
    });
    const result = await runImageDrop(
      ['10.png', '3.jpg', '2.png', '1.png'],
      f.target,
      f.operations,
    );
    expect(result).toMatchObject({
      attempted: 4,
      inserted: 2,
      failures: [
        { path: '2.png', message: 'corrupt image' },
        { path: '3.jpg', message: 'recovery full' },
      ],
    });
    expect(f.target.insert).toHaveBeenCalledExactlyOnceWith(['token:1.png', 'token:10.png']);
    expect(f.operations.cancelImage).toHaveBeenCalledExactlyOnceWith('original-tab', 'token:3.jpg');
    expect(f.operations.settleImage).toHaveBeenCalledTimes(2);
  });

  it('cancels both earlier successes and a delayed current import if the target closes', async () => {
    const f = fixture();
    const read = deferred<string>();
    vi.mocked(f.operations.importImage)
      .mockResolvedValueOnce('one')
      .mockImplementationOnce(() => read.promise);
    const pending = runImageDrop(['1.png', '2.png', '10.png'], f.target, f.operations);
    await vi.waitFor(() => expect(f.operations.importImage).toHaveBeenCalledTimes(2));
    f.invalidate('target-closed');
    read.resolve('two');
    expect(await pending).toMatchObject({ inserted: 0, reason: 'target-closed' });
    expect(f.operations.cancelImage).toHaveBeenCalledWith('original-tab', 'one');
    expect(f.operations.cancelImage).toHaveBeenCalledWith('original-tab', 'two');
    expect(f.target.insert).not.toHaveBeenCalled();
    expect(f.operations.settleImage).not.toHaveBeenCalled();
    expect(f.target.release).toHaveBeenCalledOnce();
  });

  it('abandons a mode change during protection without inserting empty references', async () => {
    const f = fixture();
    const gate = deferred<void>();
    vi.mocked(f.operations.protectImage).mockImplementation(() => gate.promise);
    const pending = runImageDrop(['1.png'], f.target, f.operations);
    await vi.waitFor(() => expect(f.operations.protectImage).toHaveBeenCalledOnce());
    f.invalidate('target-changed');
    gate.resolve();
    expect(await pending).toMatchObject({ inserted: 0, reason: 'target-changed' });
    expect(f.operations.cancelImage).toHaveBeenCalledExactlyOnceWith('original-tab', 'token:1.png');
    expect(f.target.insert).not.toHaveBeenCalled();
  });

  it('releases every ready stash when composition or a detached editor rejects insertion', async () => {
    const f = fixture();
    vi.mocked(f.target.insert).mockReturnValue(false);
    expect(await runImageDrop(['1.png', '2.png'], f.target, f.operations)).toMatchObject({
      inserted: 0,
      reason: 'editor-unavailable',
    });
    expect(f.operations.cancelImage).toHaveBeenCalledTimes(2);
    expect(f.operations.settleImage).not.toHaveBeenCalled();
    expect(f.target.release).toHaveBeenCalledOnce();
  });
});

function source(initial: string) {
  let text = initial;
  const api: SourceEditorApi = {
    read: () => ({ text, start: 0, end: 0 }),
    applyEdits: (edits) => {
      const prepared = prepareSourceEdits(text, edits);
      if (!prepared) return false;
      change(prepared.text, prepared.edits, (offset) =>
        mapSourceEditOffset(offset, prepared.edits),
      );
      return true;
    },
    undo: () => {},
    redo: () => {},
  };
  function change(
    after: string,
    edits?: readonly SourceTextEdit[],
    mapper?: (at: number) => number,
  ) {
    const before = text;
    text = after;
    publishSourceEditorChange(api, before, after, edits, mapper);
  }
  return { api, change };
}

describe('source image drop position leases', () => {
  it('maps through separate prefix/suffix edits without replacing new input', () => {
    const original = 'before TARGET after';
    const f = source(original);
    const lease = trackSourcePosition(f.api, original.indexOf('TARGET'));
    f.api.applyEdits([
      { from: 0, to: 0, text: 'new ' },
      { from: original.length, to: original.length, text: ' tail' },
    ]);
    const current = f.api.read().text;
    expect(lease.read()).toBe(current.indexOf('TARGET'));
    f.api.applyEdits([{ from: lease.read()!, to: lease.read()!, text: '![](mdplus-image:one)' }]);
    expect(f.api.read().text).toBe('new before ![](mdplus-image:one)TARGET after tail');
    lease.release();
    expect(lease.read()).toBeNull();
  });

  it('restores an observed anchor after undo and redo of multiple disjoint edits', () => {
    const original = 'abc target xyz';
    const f = source(original);
    const lease = trackSourcePosition(f.api, original.indexOf('target'));
    f.api.applyEdits([
      { from: 0, to: 3, text: 'first-prefix' },
      { from: original.length - 3, to: original.length, text: 'last-suffix' },
    ]);
    const edited = f.api.read().text;
    expect(lease.read()).toBe(edited.indexOf('target'));
    f.change(original);
    expect(lease.read()).toBe(original.indexOf('target'));
    f.change(edited);
    expect(lease.read()).toBe(edited.indexOf('target'));
    lease.release();
  });

  it('uses the exact image migration mapper ahead of a document-wide text diff', () => {
    const original = '![](mdplus-image:one)\nTARGET\n![](mdplus-image:two)';
    const f = source(original);
    const lease = trackSourcePosition(f.api, original.indexOf('TARGET'));
    const migrated = '![](./assets/one.png)\nTARGET\n![](./assets/a-long-two.png)';
    const map = vi.fn(() => migrated.indexOf('TARGET'));
    f.change(migrated, undefined, map);
    expect(lease.read()).toBe(migrated.indexOf('TARGET'));
    expect(map).toHaveBeenCalledExactlyOnceWith(original.indexOf('TARGET'));
    lease.release();
  });

  it('keeps typing at the original boundary before the arriving image', () => {
    const f = source('left right');
    const lease = trackSourcePosition(f.api, 5);
    f.change('left TYPEDright');
    expect(lease.read()).toBe(10);
    lease.release();
  });

  it('keeps API insertions at the original boundary before the arriving image with its exact mapper', () => {
    const f = source('left right');
    const lease = trackSourcePosition(f.api, 5);
    f.api.applyEdits([{ from: 5, to: 5, text: 'TYPED' }]);
    expect(lease.read()).toBe(10);
    lease.release();
  });
});
