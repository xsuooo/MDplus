import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  images: [] as any[],
  restore: vi.fn(),
  capture: vi.fn(),
  stage: vi.fn(),
  leases: [] as any[],
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
function mockedImageOps() {
  return {
    getPendingImages: () => mocks.images,
    getInFlightImages: () =>
      mocks.images.filter(
        (image) =>
          image.inserting ||
          mocks.leases.some(
            (lease) =>
              lease.release.mock.calls.length === 0 &&
              lease.images.some((captured: any) => captured.placeholder === image.placeholder),
          ),
      ),
    capturePendingImages: mocks.capture,
    restorePendingImages: mocks.restore,
    stagePendingImages: mocks.stage,
  };
}
vi.mock('../src/lib/imageOps', () => mockedImageOps());

function imageTransport(command: string, args: any = {}) {
  if (command === 'cache_recovery_image' || command === 'write_recovery_snapshot')
    return { removedKeys: [], cleanupError: null };
  if (command === 'stash_image')
    return {
      key: args.dataBase64,
      mime: 'image/png',
      previewUrl: `http://mdplus-image-stash.localhost/${args.dataBase64}`,
    };
  if (command === 'read_stashed_image') return { mime: 'image/png', dataBase64: args.key };
}

const tab = {
  id: 'test-id',
  title: '中文 文档.md',
  path: 'D:\\中文 空格\\文档.md',
  markdown: 'draft',
};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.invoke
    .mockReset()
    .mockImplementation(async (command, args) => imageTransport(command, args));
  mocks.images = [];
  mocks.leases = [];
  mocks.restore.mockReset();
  mocks.stage
    .mockReset()
    .mockImplementation(async (images) => ({ images, dispose: vi.fn(async () => {}) }));
  mocks.capture.mockReset().mockImplementation((_id: string, urls?: Iterable<string>) => {
    const wanted = urls === undefined ? undefined : new Set(urls);
    const bytes = new Map<string, string>();
    const images = mocks.images
      .filter((image) => !wanted || wanted.has(image.placeholder) || wanted.has(image.source?.url))
      .map((image) => {
        const { data, dataBase64, ...metadata } = image;
        const encoded = dataBase64 ?? Buffer.from(data ?? []).toString('base64');
        bytes.set(image.placeholder, encoded);
        return {
          ...metadata,
          source: image.source ? { ...image.source } : undefined,
          mime: image.mime ?? 'image/png',
          byteLength: image.byteLength ?? Buffer.from(encoded, 'base64').length,
        };
      });
    let released = false;
    const lease = {
      images,
      release: vi.fn(() => {
        released = true;
      }),
      withStashKey: vi.fn(
        async (placeholder: string, consume: (stashKey: string) => Promise<unknown>) => {
          if (released || !bytes.has(placeholder)) throw new Error('released image lease');
          return consume(bytes.get(placeholder)!);
        },
      ),
      withDataBase64: vi.fn(
        async (placeholder: string, consume: (data: string) => Promise<unknown>) => {
          if (released || !bytes.has(placeholder)) throw new Error('released image lease');
          return consume(bytes.get(placeholder)!);
        },
      ),
    };
    mocks.leases.push(lease);
    return lease;
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('durable recovery journal', () => {
  it('recaches an image after its recovery duplicate is collected, leaving undo bytes available', async () => {
    mocks.images = [{ placeholder: 'mdplus-image:old', filename: 'old.png', data: [1] }];
    const { protectPastedImage, scheduleRecovery } = await import('../src/lib/recovery');
    await protectPastedImage(tab.id, 'mdplus-image:old');
    mocks.invoke.mockImplementation(async (command, args) =>
      command === 'write_recovery_snapshot'
        ? { removedKeys: ['old.png'], cleanupError: null }
        : imageTransport(command, args),
    );
    scheduleRecovery({ ...tab, markdown: 'no images' }, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    await protectPastedImage(tab.id, 'mdplus-image:old');
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'cache_recovery_image'),
    ).toHaveLength(2);
  });

  it('retains the pending capture and ready batch without treating unwritten keys as cached', async () => {
    mocks.images = [
      { placeholder: 'mdplus-image:a', filename: 'a.png', data: [1] },
      { placeholder: 'mdplus-image:b', filename: 'b.png', data: [2], inserting: true },
    ];
    const { protectPastedImage, scheduleRecovery } = await import('../src/lib/recovery');
    scheduleRecovery({ ...tab, markdown: '![](mdplus-image:a)' }, vi.fn());
    await protectPastedImage(tab.id, 'mdplus-image:b');
    const first = mocks.invoke.mock.calls.find(
      ([command]) => command === 'cache_recovery_image',
    )![1];
    expect(first.retainedKeys.sort()).toEqual(['a.png', 'b.png']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      mocks.invoke.mock.calls
        .filter(([command]) => command === 'cache_recovery_image')
        .map(([, args]) => args.key),
    ).toEqual(['b.png', 'a.png']);
  });

  it('keeps a committed snapshot protected when auxiliary cleanup fails and retries cached images', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.images = [{ placeholder: 'mdplus-image:image', filename: 'image.png', data: [1] }];
      const { protectPastedImage, scheduleRecovery } = await import('../src/lib/recovery');
      await protectPastedImage(tab.id, 'mdplus-image:image');
      mocks.invoke.mockImplementation(async (command, args) =>
        command === 'write_recovery_snapshot'
          ? { removedKeys: [], cleanupError: 'locked orphan' }
          : imageTransport(command, args),
      );
      const status = vi.fn();
      scheduleRecovery({ ...tab, markdown: '![](mdplus-image:image)' }, status);
      await vi.advanceTimersByTimeAsync(1000);
      expect(status).toHaveBeenLastCalledWith('protected');
      expect(warning).toHaveBeenCalled();
      await protectPastedImage(tab.id, 'mdplus-image:image');
      expect(
        mocks.invoke.mock.calls.filter(([command]) => command === 'cache_recovery_image'),
      ).toHaveLength(2);
    } finally {
      warning.mockRestore();
    }
  });

  it('invalidates cached-key knowledge when deletion only partially completes', async () => {
    mocks.images = [{ placeholder: 'mdplus-image:image', filename: 'image.png', data: [1] }];
    const { protectPastedImage, clearRecovery } = await import('../src/lib/recovery');
    await protectPastedImage(tab.id, 'mdplus-image:image');
    mocks.invoke.mockRejectedValueOnce(new Error('cleanup interrupted'));
    await expect(clearRecovery(tab.id)).rejects.toThrow('cleanup interrupted');
    await protectPastedImage(tab.id, 'mdplus-image:image');
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'cache_recovery_image'),
    ).toHaveLength(2);
  });
  it('debounces input and commits only the newest snapshot', async () => {
    const { scheduleRecovery } = await import('../src/lib/recovery');
    const status = vi.fn();
    scheduleRecovery(tab, status);
    await vi.advanceTimersByTimeAsync(700);
    scheduleRecovery({ ...tab, markdown: 'newer' }, status);
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('write_recovery_snapshot', {
      retainedKeys: [],
      snapshot: {
        id: tab.id,
        title: tab.title,
        originalPath: tab.path,
        markdown: 'newer',
        images: [],
      },
    });
    expect(status).toHaveBeenLastCalledWith('protected');
  });

  it('persists image bytes before completing paste protection and before the manifest', async () => {
    mocks.images = [{ placeholder: 'mdplus-image:image', filename: '图片 一.png', data: [1, 2] }];
    const { protectPastedImage, scheduleRecovery } = await import('../src/lib/recovery');
    const gate = deferred();
    mocks.invoke.mockImplementation((command) =>
      command === 'cache_recovery_image'
        ? gate.promise.then(() => imageTransport(command))
        : Promise.resolve(imageTransport(command)),
    );
    let protectedImage = false;
    const pending = protectPastedImage(tab.id, 'mdplus-image:image').then(() => {
      protectedImage = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(protectedImage).toBe(false);
    gate.resolve();
    await pending;
    scheduleRecovery({ ...tab, markdown: '![](mdplus-image:image)' }, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'cache_recovery_image',
      'write_recovery_snapshot',
    ]);
    expect(mocks.leases[0].withDataBase64).not.toHaveBeenCalled();
    expect(mocks.leases[0].withStashKey).toHaveBeenCalledOnce();
  });

  it('does not mark data protected when image or manifest writes fail', async () => {
    const { scheduleRecovery, protectPastedImage } = await import('../src/lib/recovery');
    mocks.images = [{ placeholder: 'mdplus-image:image', filename: 'image.png', data: [1] }];
    mocks.invoke.mockRejectedValue(new Error('disk full'));
    await expect(protectPastedImage(tab.id, 'mdplus-image:image')).rejects.toThrow('disk full');
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown: '![](mdplus-image:image)' }, status);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenLastCalledWith('error');
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'write_recovery_snapshot')).toBe(
      false,
    );
  });

  it('clears only after in-flight writes and cancels pending timers', async () => {
    const { scheduleRecovery, clearRecovery } = await import('../src/lib/recovery');
    const gate = deferred();
    mocks.invoke.mockImplementation((command) =>
      command === 'write_recovery_snapshot'
        ? gate.promise.then(() => imageTransport(command))
        : Promise.resolve(imageTransport(command)),
    );
    scheduleRecovery(tab, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    const clearing = clearRecovery(tab.id);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    gate.resolve();
    await clearing;
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'write_recovery_snapshot',
      'delete_recovery_snapshot',
    ]);
    scheduleRecovery(tab, vi.fn());
    await clearRecovery(tab.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'write_recovery_snapshot'),
    ).toHaveLength(1);
  });

  it('captures original aliases before Save As changes the cached source', async () => {
    const image = {
      placeholder: 'mdplus-image:image',
      filename: '中文.png',
      data: [1],
      source: { url: './旧 目录/中文.png' },
    };
    mocks.images = [image];
    const { scheduleRecovery } = await import('../src/lib/recovery');
    scheduleRecovery({ ...tab, markdown: '![](<./旧 目录/中文.png>)' }, vi.fn());
    image.source.url = './new/image.png';
    await vi.advanceTimersByTimeAsync(1000);
    const snapshot = mocks.invoke.mock.calls.find(
      ([command]) => command === 'write_recovery_snapshot',
    )![1].snapshot;
    expect(snapshot.markdown).toBe('![](<mdplus-image:image>)');
  });

  it('refuses a temporary token whose bytes are missing', async () => {
    const { scheduleRecovery } = await import('../src/lib/recovery');
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown: '![](mdplus-image:missing)' }, status);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenLastCalledWith('error');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('does not delete a recovered snapshot before the user saves or discards it', async () => {
    const { restoreRecovery } = await import('../src/lib/recovery');
    const snapshot = { id: tab.id, markdown: 'recovered', originalPath: tab.path, images: [] };
    mocks.invoke.mockResolvedValue({ snapshot, images: [] });
    expect(await restoreRecovery(tab.id)).toEqual(snapshot);
    expect(mocks.restore).toHaveBeenCalledWith(tab.id, expect.objectContaining({ images: [] }));
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('read_recovery_snapshot', { id: tab.id });
  });
});

describe('recovery image preparation boundary', () => {
  beforeEach(() => {
    vi.doUnmock('../src/lib/imageOps');
  });
  afterEach(() => {
    vi.doMock('../src/lib/imageOps', () => mockedImageOps());
  });

  it.each(['![](./img/new.png)', '![new][picture]\n\n[picture]: <./img/new.png>'])(
    'refuses an uncached relative image: %s',
    async (markdown) => {
      const { scheduleRecovery } = await import('../src/lib/recovery');
      const status = vi.fn();
      scheduleRecovery({ ...tab, markdown }, status);
      await vi.advanceTimersByTimeAsync(1000);
      expect(status).toHaveBeenLastCalledWith('error');
      expect(mocks.invoke).not.toHaveBeenCalled();
    },
  );

  it('captures current image bytes only after preparation commits', async () => {
    const { prepareImageReferences } = await import('../src/lib/imageOps');
    const { scheduleRecovery } = await import('../src/lib/recovery');
    const image = { path: 'D:/中文 空格/img/new.png', mime: 'image/png', dataBase64: 'QUJD' };
    const read = deferred<typeof image>();
    mocks.invoke.mockImplementation((command, args) =>
      command === 'read_image_file' ? read.promise : Promise.resolve(imageTransport(command, args)),
    );
    const markdown = '![](./img/new.png)';
    const ready = prepareImageReferences(tab.id, markdown, tab.path).then((prepared) =>
      prepared.commit(),
    );
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown }, status, ready);
    await vi.advanceTimersByTimeAsync(1500);
    expect(status.mock.calls).toEqual([['pending']]);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['read_image_file']);
    read.resolve(image);
    expect(await ready).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'read_image_file',
      'stash_image',
    ]);
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenLastCalledWith('protected');
    const snapshot = mocks.invoke.mock.calls.find(
      ([command]) => command === 'write_recovery_snapshot',
    )![1].snapshot;
    expect(snapshot.images).toHaveLength(1);
    expect(snapshot.images[0].placeholder).toMatch(/^mdplus-image:/);
    expect(snapshot.markdown).toBe(`![](${snapshot.images[0].placeholder})`);
    expect(mocks.invoke).toHaveBeenCalledWith('cache_recovery_image', {
      id: tab.id,
      key: snapshot.images[0].key,
      stashKey: 'QUJD',
      retainedKeys: [snapshot.images[0].key],
    });
  });

  it.each(['true', 'false', 'reject'])(
    'ignores a superseded preparation outcome: %s',
    async (outcome) => {
      const { scheduleRecovery } = await import('../src/lib/recovery');
      const gate = deferred<boolean>();
      const oldStatus = vi.fn();
      const status = vi.fn();
      scheduleRecovery({ ...tab, markdown: '![](./img/old.png)' }, oldStatus, gate.promise);
      scheduleRecovery({ ...tab, markdown: 'newest draft' }, status);
      await vi.advanceTimersByTimeAsync(1000);
      expect(status).toHaveBeenLastCalledWith('protected');
      if (outcome === 'reject') gate.reject(new Error('old image read failed'));
      else gate.resolve(outcome === 'true');
      await vi.advanceTimersByTimeAsync(1000);
      expect(oldStatus.mock.calls).toEqual([['pending']]);
      expect(status).toHaveBeenLastCalledWith('protected');
      expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('write_recovery_snapshot', {
        retainedKeys: [],
        snapshot: {
          id: tab.id,
          title: tab.title,
          originalPath: tab.path,
          markdown: 'newest draft',
          images: [],
        },
      });
    },
  );

  it('retains the previous durable snapshot when preparation returns false', async () => {
    const { scheduleRecovery } = await import('../src/lib/recovery');
    scheduleRecovery(tab, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    mocks.invoke.mockClear();
    const gate = deferred<boolean>();
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown: 'newer' }, status, gate.promise);
    gate.resolve(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status.mock.calls).toEqual([['pending'], ['error']]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('reports rejected preparation without replacing or deleting durable data', async () => {
    const { scheduleRecovery } = await import('../src/lib/recovery');
    scheduleRecovery(tab, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    mocks.invoke.mockClear();
    const gate = deferred<boolean>();
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown: 'newer' }, status, gate.promise);
    gate.reject(new Error('preparation failed'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(status.mock.calls).toEqual([['pending'], ['error']]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('does not treat true readiness as proof of missing image bytes', async () => {
    const { scheduleRecovery } = await import('../src/lib/recovery');
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown: '![](./img/missing.png)' }, status, Promise.resolve(true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(status.mock.calls).toEqual([['pending'], ['error']]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('rejects an empty compact image before publishing an alias or recovery snapshot', async () => {
    const { prepareImageReferences } = await import('../src/lib/imageOps');
    const { scheduleRecovery } = await import('../src/lib/recovery');
    mocks.invoke.mockResolvedValue({
      path: 'D:/中文 空格/img/empty.png',
      mime: 'image/png',
      dataBase64: '',
    });
    const markdown = '![](./img/empty.png)';
    const ready = prepareImageReferences(tab.id, markdown, tab.path).then((prepared) =>
      prepared.commit(),
    );
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown }, status, ready);
    await expect(ready).rejects.toThrow('图片为空');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status.mock.calls).toEqual([['pending'], ['error']]);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['read_image_file']);
  });

  it('invalidates a pending preparation on explicit cleanup', async () => {
    const { scheduleRecovery, clearRecovery } = await import('../src/lib/recovery');
    const gate = deferred<boolean>();
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown: '![](./img/closed.png)' }, status, gate.promise);
    await clearRecovery(tab.id);
    mocks.invoke.mockClear();
    gate.resolve(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status.mock.calls).toEqual([['pending']]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('cancels an older debounce immediately while newer preparation is pending', async () => {
    const { scheduleRecovery } = await import('../src/lib/recovery');
    const oldStatus = vi.fn();
    scheduleRecovery(tab, oldStatus);
    await vi.advanceTimersByTimeAsync(900);
    const gate = deferred<boolean>();
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown: 'newer' }, status, gate.promise);
    await vi.advanceTimersByTimeAsync(2000);
    expect(oldStatus.mock.calls).toEqual([['pending']]);
    expect(status.mock.calls).toEqual([['pending']]);
    expect(mocks.invoke).not.toHaveBeenCalled();
    gate.resolve(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenLastCalledWith('error');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('bounded recovery capture leases', () => {
  it('releases cancelled debounce captures immediately, including on explicit cleanup', async () => {
    const { scheduleRecovery, clearRecovery } = await import('../src/lib/recovery');
    scheduleRecovery(tab, vi.fn());
    const first = mocks.leases[0];
    expect(first.release).not.toHaveBeenCalled();
    scheduleRecovery({ ...tab, markdown: 'newer' }, vi.fn());
    expect(first.release).toHaveBeenCalledTimes(1);
    const second = mocks.leases[1];
    await clearRecovery(tab.id);
    expect(second.release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'write_recovery_snapshot'),
    ).toHaveLength(0);
  });

  it('drops obsolete queued captures but keeps a running native cache copy pinned until it settles', async () => {
    mocks.images = [{ placeholder: 'mdplus-image:image', filename: 'image.png', data: [1, 2] }];
    const { scheduleRecovery } = await import('../src/lib/recovery');
    const gate = deferred();
    mocks.invoke.mockImplementation((command) =>
      command === 'cache_recovery_image'
        ? gate.promise.then(() => imageTransport(command))
        : Promise.resolve(imageTransport(command)),
    );
    scheduleRecovery({ ...tab, markdown: '![](mdplus-image:image)' }, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    const running = mocks.leases[0];
    expect(running.withStashKey).toHaveBeenCalledTimes(1);
    expect(running.withDataBase64).not.toHaveBeenCalled();
    expect(running.release).not.toHaveBeenCalled();
    scheduleRecovery({ ...tab, markdown: 'obsolete queued' }, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    const queued = mocks.leases[1];
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown: 'latest' }, status);
    expect(queued.release).toHaveBeenCalledTimes(1);
    expect(running.release).not.toHaveBeenCalled();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(running.release).toHaveBeenCalledTimes(1);
    expect(mocks.leases[2].release).toHaveBeenCalledTimes(1);
    const snapshots = mocks.invoke.mock.calls.filter(
      ([command]) => command === 'write_recovery_snapshot',
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0][1].snapshot.markdown).toBe('latest');
    expect(status).toHaveBeenLastCalledWith('protected');
  });

  it('releases the active capture even if its manifest write fails', async () => {
    const { scheduleRecovery } = await import('../src/lib/recovery');
    mocks.invoke.mockRejectedValueOnce(new Error('disk full'));
    const status = vi.fn();
    scheduleRecovery(tab, status);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenLastCalledWith('error');
    expect(mocks.leases[0].release).toHaveBeenCalledTimes(1);
  });

  it('releases a paste capture if its owning tab is no longer current before queued I/O', async () => {
    mocks.images = [{ placeholder: 'mdplus-image:image', filename: 'image.png', data: [1] }];
    const { protectPastedImage } = await import('../src/lib/recovery');
    await expect(protectPastedImage(tab.id, 'mdplus-image:image', () => false)).rejects.toThrow(
      '取消',
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.leases[0].release).toHaveBeenCalledTimes(1);
  });

  it('disposes asynchronously staged images if deletion invalidates their pending restore', async () => {
    const { prepareRecovery, clearRecovery } = await import('../src/lib/recovery');
    const gate = deferred<{ dispose: ReturnType<typeof vi.fn> }>();
    const dispose = vi.fn(async () => {});
    mocks.invoke.mockImplementation(async (command) =>
      command === 'read_recovery_snapshot'
        ? {
            snapshot: {
              id: tab.id,
              title: 'restored',
              originalPath: null,
              markdown: 'draft',
              images: [],
            },
            images: [],
          }
        : undefined,
    );
    mocks.stage.mockReturnValueOnce(gate.promise);
    const loading = prepareRecovery(tab.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    await clearRecovery(tab.id);
    gate.resolve({ dispose });
    const prepared = await loading;
    expect(prepared.commit()).toBe(false);
    await prepared.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
