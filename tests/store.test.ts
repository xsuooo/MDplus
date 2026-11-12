import { beforeEach, describe, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
vi.mock('../src/services/settingsStore', () => ({ loadSettingsStore: load }));

beforeEach(() => {
  vi.resetModules();
  load.mockReset();
});

function fakeStore() {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    save: vi.fn(async () => {}),
  };
}

describe('settings store load and write recovery', () => {
  it('reports recent-list read failures instead of presenting them as an empty list', async () => {
    load.mockRejectedValueOnce(new Error('settings unavailable'));
    const settings = await import('../src/lib/store');
    await expect(settings.getRecentFiles()).rejects.toThrow('settings unavailable');
  });

  it('rejects failed recent writes, restores the prior list and permits retry', async () => {
    const store = fakeStore();
    const original = [{ path: 'C:/notes/a.md', name: 'a.md', time: 1 }];
    await store.set('recent-files', original);
    store.save
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'));
    load.mockResolvedValue(store);
    const settings = await import('../src/lib/store');
    await expect(settings.pushRecentFile('C:/notes/b.md', 'b.md')).rejects.toThrow('disk full');
    await expect(settings.removeRecentFile('C:/notes/a.md')).rejects.toThrow('disk full');
    expect(await settings.getRecentFiles()).toEqual(original);
    await settings.removeRecentFile('C:/notes/a.md');
    expect(await settings.getRecentFiles()).toEqual([]);
  });
  it('retries a transient first-load failure on a later write', async () => {
    const store = fakeStore();
    load.mockRejectedValueOnce(new Error('temporary sharing violation')).mockResolvedValue(store);
    const settings = await import('../src/lib/store');
    expect(await settings.getThemeMode()).toBe('light');
    await settings.setThemeMode('dark');
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.set).toHaveBeenCalledWith('theme-mode', 'dark');
    expect(store.save).toHaveBeenCalledOnce();
    expect(await settings.getThemeMode()).toBe('dark');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares each load attempt among concurrent readers and permits the next retry', async () => {
    let reject!: (error: Error) => void;
    const first = new Promise<never>((_, fail) => {
      reject = fail;
    });
    const store = fakeStore();
    await store.set('theme-mode', 'dark');
    load.mockReturnValueOnce(first).mockResolvedValue(store);
    const settings = await import('../src/lib/store');
    const readers = [
      settings.getThemeMode(),
      settings.getSourceModePref(),
      settings.getWindowState(),
    ];
    expect(load).toHaveBeenCalledOnce();
    reject(new Error('transient load failure'));
    expect(await Promise.all(readers)).toEqual(['light', false, null]);
    expect(await Promise.all([settings.getThemeMode(), settings.getSourceModePref()])).toEqual([
      'dark',
      false,
    ]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps queued writes ordered when the first operation fails to load', async () => {
    const store = fakeStore();
    load.mockRejectedValueOnce(new Error('busy settings file')).mockResolvedValue(store);
    const settings = await import('../src/lib/store');
    const outcomes = await Promise.allSettled([
      settings.setThemeMode('light'),
      settings.setThemeMode('dark'),
      settings.setSourceModePref(true),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.set.mock.calls).toEqual([
      ['theme-mode', 'dark'],
      ['source-mode', true],
    ]);
    expect(store.save).toHaveBeenCalledTimes(2);
  });

  it('retries another failed attempt without discarding a later successful cache', async () => {
    const store = fakeStore();
    load
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValue(store);
    const settings = await import('../src/lib/store');
    expect(await settings.getThemeMode()).toBe('light');
    expect(await settings.getThemeMode()).toBe('light');
    await settings.setSourceModePref(true);
    expect(await settings.getSourceModePref()).toBe(true);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('replaces raw relative/extended aliases with the opened native identity', async () => {
    const store = fakeStore();
    await store.set('recent-files', [
      { path: 'a.md', name: 'a.md', time: 2 },
      { path: '\\\\?\\C:\\notes\\.\\a.md', name: 'a.md', time: 1 },
      { path: 'C:/notes/b.md', name: 'b.md', time: 0 },
    ]);
    load.mockResolvedValue(store);
    const settings = await import('../src/lib/store');
    await settings.pushRecentFile('C:/notes/a.md', 'a.md', 'a.md');
    expect((await settings.getRecentFiles()).map((file) => file.path)).toEqual([
      'C:/notes/a.md',
      'C:/notes/b.md',
    ]);
    await settings.removeRecentFile('C:/NOTES/sub/../a.md');
    expect((await settings.getRecentFiles()).map((file) => file.path)).toEqual(['C:/notes/b.md']);
  });
});

describe('preference recovery boundaries', () => {
  it('reports a failed startup read and retries without caching fallback values', async () => {
    const store = fakeStore();
    await store.set('theme-mode', 'dark');
    store.get.mockRejectedValueOnce(new Error('settings unavailable'));
    load.mockResolvedValue(store);
    const settings = await import('../src/lib/store');
    await expect(settings.loadPreferences()).rejects.toThrow('settings unavailable');
    expect((await settings.loadPreferences()).themeMode).toBe('dark');
    expect(load).toHaveBeenCalledOnce();
  });

  it('surfaces a failed durable write while allowing an explicit retry', async () => {
    const store = fakeStore();
    store.save.mockRejectedValueOnce(new Error('disk full'));
    load.mockResolvedValue(store);
    const settings = await import('../src/lib/store');
    await expect(settings.setThemeMode('dark')).rejects.toThrow('disk full');
    await expect(settings.setThemeMode('system')).resolves.toBeUndefined();
    expect(store.set.mock.calls).toEqual([
      ['theme-mode', 'dark'],
      ['theme-mode', 'system'],
    ]);
    expect(store.save).toHaveBeenCalledTimes(2);
  });

  it('rejects a failed mutation without poisoning subsequent preference writes', async () => {
    const store = fakeStore();
    store.set.mockRejectedValueOnce(new Error('store mutation failed'));
    load.mockResolvedValue(store);
    const settings = await import('../src/lib/store');
    await expect(settings.setOutlineOpen(true)).rejects.toThrow('store mutation failed');
    await settings.setOutlineOpen(false);
    expect(store.save).toHaveBeenCalledOnce();
  });
});
