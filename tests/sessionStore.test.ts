import { beforeEach, describe, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
vi.mock('../src/services/settingsStore', () => ({ loadSettingsStore: load }));
beforeEach(() => {
  vi.resetModules();
  load.mockReset();
});
function settingsStore(values = new Map<string, unknown>()) {
  return {
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    save: vi.fn(async () => {}),
    values,
  };
}

describe('session settings persistence', () => {
  it('rolls back a rejected switch before a later unrelated write can persist it', async () => {
    const store = settingsStore();
    store.save.mockRejectedValueOnce(new Error('temporary disk failure'));
    load.mockResolvedValue(store);
    const { setSessionRestoreEnabled, setThemeMode, loadDocumentSession } =
      await import('../src/lib/store');
    await expect(setSessionRestoreEnabled(false)).rejects.toThrow('temporary disk failure');
    await setThemeMode('dark');
    expect((await loadDocumentSession()).enabled).toBe(true);
    expect(store.values.get('session-restore-enabled')).toBe(true);
  });
  it('defaults restoration on and distinguishes unavailable settings from an empty session', async () => {
    const store = settingsStore();
    load.mockRejectedValueOnce(new Error('temporary read failure')).mockResolvedValue(store);
    const { loadDocumentSession } = await import('../src/lib/store');
    await expect(loadDocumentSession()).rejects.toThrow('temporary read failure');
    await expect(loadDocumentSession()).resolves.toEqual({
      enabled: true,
      session: { version: 1, documents: [], activePath: null },
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('saves only metadata and preserves unrelated pending recovery settings', async () => {
    const store = settingsStore(
      new Map([['independent-recovery', { id: 'draft-a', markdown: 'only surviving draft' }]]),
    );
    load.mockResolvedValue(store);
    const { saveDocumentSession, setSessionRestoreEnabled, loadDocumentSession } =
      await import('../src/lib/store');
    await setSessionRestoreEnabled(false);
    await saveDocumentSession({
      version: 1,
      documents: [{ path: 'C:/a.md', title: 'a.md' }],
      activePath: 'C:/a.md',
    });
    expect((await loadDocumentSession()).enabled).toBe(false);
    expect(store.values.get('independent-recovery')).toEqual({
      id: 'draft-a',
      markdown: 'only surviving draft',
    });
    expect(store.set.mock.calls.map(([key]) => key)).toEqual([
      'session-restore-enabled',
      'document-session',
    ]);
  });

  it('reports failed durable session writes and allows a later retry without poisoning other writes', async () => {
    const store = settingsStore();
    store.save.mockRejectedValueOnce(new Error('disk full'));
    load.mockResolvedValue(store);
    const { saveDocumentSession, setThemeMode } = await import('../src/lib/store');
    const snapshot = {
      version: 1 as const,
      documents: [{ path: 'C:/a.md', title: 'a.md' }],
      activePath: 'C:/a.md',
    };
    await expect(saveDocumentSession(snapshot)).rejects.toThrow('disk full');
    await saveDocumentSession(snapshot);
    await setThemeMode('dark');
    expect(store.save).toHaveBeenCalledTimes(3);
    expect(store.values.get('document-session')).toEqual(snapshot);
    expect(store.values.get('theme-mode')).toBe('dark');
  });
});
