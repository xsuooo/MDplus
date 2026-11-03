import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), images: [] as any[], restore: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('../src/lib/imageOps', () => ({ getPendingImages: () => mocks.images, restorePendingImages: mocks.restore }));

const tab = { id: 'test-id', title: '中文 文档.md', path: 'D:\\中文 空格\\文档.md', markdown: 'draft' };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.images = []; mocks.restore.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe('durable recovery journal', () => {
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
      snapshot: { id: tab.id, title: tab.title, originalPath: tab.path, markdown: 'newer', images: [] },
    });
    expect(status).toHaveBeenLastCalledWith('protected');
  });

  it('persists image bytes before completing paste protection and before the manifest', async () => {
    mocks.images = [{ placeholder: 'mdplus-image:image', filename: '图片 一.png', data: [1, 2] }];
    const { protectPastedImage, scheduleRecovery } = await import('../src/lib/recovery');
    const gate = deferred();
    mocks.invoke.mockImplementation((command) => command === 'cache_recovery_image' ? gate.promise : Promise.resolve());
    let protectedImage = false;
    const pending = protectPastedImage(tab.id, 'mdplus-image:image').then(() => { protectedImage = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(protectedImage).toBe(false);
    gate.resolve(); await pending;
    scheduleRecovery({ ...tab, markdown: '![](mdplus-image:image)' }, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['cache_recovery_image', 'write_recovery_snapshot']);
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
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'write_recovery_snapshot')).toBe(false);
  });

  it('clears only after in-flight writes and cancels pending timers', async () => {
    const { scheduleRecovery, clearRecovery } = await import('../src/lib/recovery');
    const gate = deferred();
    mocks.invoke.mockImplementation((command) => command === 'write_recovery_snapshot' ? gate.promise : Promise.resolve());
    scheduleRecovery(tab, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    const clearing = clearRecovery(tab.id);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    gate.resolve(); await clearing;
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['write_recovery_snapshot', 'delete_recovery_snapshot']);
    scheduleRecovery(tab, vi.fn());
    await clearRecovery(tab.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'write_recovery_snapshot')).toHaveLength(1);
  });

  it('captures original aliases before Save As changes the cached source', async () => {
    const image = { placeholder: 'mdplus-image:image', filename: '中文.png', data: [1], source: { url: './旧 目录/中文.png' } };
    mocks.images = [image];
    const { scheduleRecovery } = await import('../src/lib/recovery');
    scheduleRecovery({ ...tab, markdown: '![](<./旧 目录/中文.png>)' }, vi.fn());
    image.source.url = './new/image.png';
    await vi.advanceTimersByTimeAsync(1000);
    const snapshot = mocks.invoke.mock.calls.find(([command]) => command === 'write_recovery_snapshot')![1].snapshot;
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
    expect(mocks.restore).toHaveBeenCalledWith(tab.id, []);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('read_recovery_snapshot', { id: tab.id });
  });
});

describe('recovery image preparation boundary', () => {
  beforeEach(() => { vi.doUnmock('../src/lib/imageOps'); });
  afterEach(() => {
    vi.doMock('../src/lib/imageOps', () => ({ getPendingImages: () => mocks.images, restorePendingImages: mocks.restore }));
  });

  it.each([
    '![](./img/new.png)',
    '![new][picture]\n\n[picture]: <./img/new.png>',
  ])('refuses an uncached relative image: %s', async (markdown) => {
    const { scheduleRecovery } = await import('../src/lib/recovery');
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown }, status);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenLastCalledWith('error');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('captures current image bytes only after preparation commits', async () => {
    const { prepareImageReferences } = await import('../src/lib/imageOps');
    const { scheduleRecovery } = await import('../src/lib/recovery');
    const image = { path: 'D:/中文 空格/img/new.png', mime: 'image/png', data: [65, 66, 67] };
    const read = deferred<typeof image>();
    mocks.invoke.mockImplementation((command) => command === 'read_image_file' ? read.promise : Promise.resolve());
    const markdown = '![](./img/new.png)';
    const ready = prepareImageReferences(tab.id, markdown, tab.path).then((prepared) => prepared.commit());
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown }, status, ready);
    await vi.advanceTimersByTimeAsync(1500);
    expect(status.mock.calls).toEqual([['pending']]);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['read_image_file']);
    read.resolve(image);
    expect(await ready).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['read_image_file']);
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenLastCalledWith('protected');
    const snapshot = mocks.invoke.mock.calls.find(([command]) => command === 'write_recovery_snapshot')![1].snapshot;
    expect(snapshot.images).toHaveLength(1);
    expect(snapshot.images[0].placeholder).toMatch(/^mdplus-image:/);
    expect(snapshot.markdown).toBe(`![](${snapshot.images[0].placeholder})`);
    expect(mocks.invoke).toHaveBeenCalledWith('cache_recovery_image', { id: tab.id, key: snapshot.images[0].key, data: [65, 66, 67] });
  });

  it.each(['true', 'false', 'reject'])('ignores a superseded preparation outcome: %s', async (outcome) => {
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
      snapshot: { id: tab.id, title: tab.title, originalPath: tab.path, markdown: 'newest draft', images: [] },
    });
  });

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

  it('rejects a prepared raw alias whose image byte array is empty', async () => {
    const { prepareImageReferences } = await import('../src/lib/imageOps');
    const { scheduleRecovery } = await import('../src/lib/recovery');
    mocks.invoke.mockResolvedValue({ path: 'D:/中文 空格/img/empty.png', mime: 'image/png', data: [] });
    const markdown = '![](./img/empty.png)';
    const ready = prepareImageReferences(tab.id, markdown, tab.path).then((prepared) => prepared.commit());
    const status = vi.fn();
    scheduleRecovery({ ...tab, markdown }, status, ready);
    expect(await ready).toBe(true);
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
