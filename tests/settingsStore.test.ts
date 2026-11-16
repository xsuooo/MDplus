import { beforeEach, expect, it, vi } from 'vitest';
import { loadSettingsStore } from '../src/services/settingsStore';
import { LIMITS } from '../src/config/constants';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
beforeEach(() => vi.resetAllMocks());

it('uses path-free native settings snapshots and atomically saves the exact revision', async () => {
  mocks.invoke
    .mockResolvedValueOnce({ values: { 'theme-mode': 'dark' }, revision: 'sha256:old' })
    .mockResolvedValueOnce({ revision: 'sha256:new' })
    .mockResolvedValueOnce({ revision: 'sha256:newer' });
  const store = await loadSettingsStore();
  expect(await store.get('theme-mode')).toBe('dark');
  expect(await store.get('missing')).toBeUndefined();
  await store.set('theme-mode', 'system');
  await store.save();
  await store.set('outline-open', true);
  await store.save();
  expect(mocks.invoke.mock.calls).toEqual([
    ['load_settings'],
    ['save_settings', { values: { 'theme-mode': 'system' }, expectedRevision: 'sha256:old' }],
    [
      'save_settings',
      {
        values: { 'theme-mode': 'system', 'outline-open': true },
        expectedRevision: 'sha256:new',
      },
    ],
  ]);
});

it('propagates a failed native load without creating a usable Store', async () => {
  mocks.invoke.mockRejectedValue(new Error('damaged settings'));
  await expect(loadSettingsStore()).rejects.toThrow('damaged settings');
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('load_settings');
});

it('retains pending settings and the old revision after a failed atomic save for retry', async () => {
  mocks.invoke
    .mockResolvedValueOnce({ values: {}, revision: null })
    .mockRejectedValueOnce(new Error('disk unavailable'))
    .mockResolvedValueOnce({ revision: 'sha256:retry' });
  const store = await loadSettingsStore();
  await store.set('theme-mode', 'dark');
  await expect(store.save()).rejects.toThrow('disk unavailable');
  expect(await store.get('theme-mode')).toBe('dark');
  await store.save();
  expect(mocks.invoke.mock.calls.slice(1)).toEqual([
    ['save_settings', { values: { 'theme-mode': 'dark' }, expectedRevision: null }],
    ['save_settings', { values: { 'theme-mode': 'dark' }, expectedRevision: null }],
  ]);
});

const stale = () => ({
  code: 'CONFLICT',
  writeState: 'unchanged',
  message: 'settings changed on disk',
});

it.each([
  ['an I/O failure', { code: 'IO_ERROR', writeState: 'unchanged', message: 'disk unavailable' }],
  ['a committed write', { code: 'CONFLICT', writeState: 'committed', message: 'check the file' }],
  ['an uncertain write', { code: 'IO_ERROR', writeState: 'unknown', message: 'check the file' }],
])('does not reload or write again after %s', async (_name, failure) => {
  mocks.invoke.mockResolvedValueOnce({ values: {}, revision: 'r1' }).mockRejectedValueOnce(failure);
  const store = await loadSettingsStore();
  await store.set('theme-mode', 'dark');
  const error = await store.save().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject(failure);
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it('keeps an externally added key when a queued save follows a conflicting one', async () => {
  mocks.invoke
    .mockResolvedValueOnce({ values: { a: 0 }, revision: 'r1' })
    .mockRejectedValueOnce(stale())
    .mockResolvedValueOnce({ values: { a: 0, added: 1 }, revision: 'r2' })
    .mockResolvedValueOnce({ revision: 'r3' })
    .mockResolvedValueOnce({ revision: 'r4' });
  const store = await loadSettingsStore();
  await store.set('a', 1);
  const first = store.save();
  await store.set('b', 2);
  const second = store.save();
  await Promise.all([first, second]);
  expect(mocks.invoke.mock.calls.slice(3)).toEqual([
    ['save_settings', { values: { a: 1, added: 1 }, expectedRevision: 'r2' }],
    ['save_settings', { values: { a: 1, added: 1, b: 2 }, expectedRevision: 'r3' }],
  ]);
  expect(await store.get('added')).toBe(1);
});

it('keeps an edit made while the changed settings are being reloaded', async () => {
  let reloaded!: (snapshot: { values: Record<string, unknown>; revision: string }) => void;
  mocks.invoke
    .mockResolvedValueOnce({ values: { a: 0 }, revision: 'r1' })
    .mockRejectedValueOnce(stale())
    .mockReturnValueOnce(new Promise((resolve) => (reloaded = resolve)))
    .mockResolvedValueOnce({ revision: 'r3' })
    .mockResolvedValueOnce({ revision: 'r4' });
  const store = await loadSettingsStore();
  await store.set('a', 1);
  const first = store.save();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(3));
  await store.set('late', true);
  reloaded({ values: { a: 0, added: 1 }, revision: 'r2' });
  await first;
  expect(mocks.invoke.mock.calls.at(-1)).toEqual([
    'save_settings',
    { values: { a: 1, added: 1 }, expectedRevision: 'r2' },
  ]);
  expect(await store.get('late')).toBe(true);
  await store.save();
  expect(mocks.invoke.mock.calls.at(-1)).toEqual([
    'save_settings',
    { values: { a: 1, added: 1, late: true }, expectedRevision: 'r3' },
  ]);
});

it('applies a queued edit that reverts an earlier one after a conflict', async () => {
  mocks.invoke
    .mockResolvedValueOnce({ values: { a: 0 }, revision: 'r1' })
    .mockRejectedValueOnce(stale())
    .mockResolvedValueOnce({ values: { a: 5 }, revision: 'r2' })
    .mockResolvedValueOnce({ revision: 'r3' })
    .mockResolvedValueOnce({ revision: 'r4' });
  const store = await loadSettingsStore();
  await store.set('a', 1);
  const first = store.save();
  await store.set('a', 0);
  const second = store.save();
  await Promise.all([first, second]);
  expect(mocks.invoke.mock.calls.slice(3)).toEqual([
    ['save_settings', { values: { a: 1 }, expectedRevision: 'r2' }],
    ['save_settings', { values: { a: 0 }, expectedRevision: 'r3' }],
  ]);
  expect(await store.get('a')).toBe(0);
});

it('merges local changes onto externally changed settings and keeps saving afterwards', async () => {
  mocks.invoke
    .mockResolvedValueOnce({
      values: { 'theme-mode': 'light', 'outline-open': true, shortcuts: { save: 'Ctrl+S' } },
      revision: 'r1',
    })
    .mockRejectedValueOnce(stale())
    .mockResolvedValueOnce({
      values: { 'theme-mode': 'sepia', 'outline-open': false, added: 1 },
      revision: 'r2',
    })
    .mockResolvedValueOnce({ revision: 'r3' })
    .mockResolvedValueOnce({ revision: 'r4' });
  const store = await loadSettingsStore();
  await store.set('theme-mode', 'dark');
  await store.save();
  // Changed here: ours. Untouched here: the file's, including its additions and removals.
  const merged = { 'theme-mode': 'dark', 'outline-open': false, added: 1 };
  expect(mocks.invoke.mock.calls.slice(1)).toEqual([
    [
      'save_settings',
      {
        values: { 'theme-mode': 'dark', 'outline-open': true, shortcuts: { save: 'Ctrl+S' } },
        expectedRevision: 'r1',
      },
    ],
    ['load_settings'],
    ['save_settings', { values: merged, expectedRevision: 'r2' }],
  ]);
  expect(await store.get('outline-open')).toBe(false);
  expect(await store.get('added')).toBe(1);
  expect(await store.get('shortcuts')).toBeUndefined();
  await store.set('outline-open', true);
  await store.save();
  expect(mocks.invoke.mock.calls.at(-1)).toEqual([
    'save_settings',
    { values: { ...merged, 'outline-open': true }, expectedRevision: 'r3' },
  ]);
});

it('retries only once when the retry conflicts too, and a later save recovers', async () => {
  mocks.invoke
    .mockResolvedValueOnce({ values: { a: 0 }, revision: 'r1' })
    .mockRejectedValueOnce(stale())
    .mockResolvedValueOnce({ values: { a: 0, added: 1 }, revision: 'r2' })
    .mockRejectedValueOnce(stale())
    // The later explicit save meets the newer file, adopts it and succeeds.
    .mockRejectedValueOnce(stale())
    .mockResolvedValueOnce({ values: { a: 0, added: 2 }, revision: 'r3' })
    .mockResolvedValueOnce({ revision: 'r4' });
  const store = await loadSettingsStore();
  await store.set('a', 1);
  await expect(store.save()).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
    'load_settings',
    'save_settings',
    'load_settings',
    'save_settings',
  ]);
  expect(await store.get('a')).toBe(1);
  await store.save();
  expect(mocks.invoke.mock.calls.at(-1)).toEqual([
    'save_settings',
    { values: { a: 1, added: 2 }, expectedRevision: 'r3' },
  ]);
});

it('reports the original failure when the changed settings cannot be read back', async () => {
  mocks.invoke
    .mockResolvedValueOnce({ values: {}, revision: 'r1' })
    .mockRejectedValueOnce(stale())
    .mockRejectedValueOnce(new Error('damaged settings'));
  const store = await loadSettingsStore();
  await store.set('theme-mode', 'dark');
  await expect(store.save()).rejects.toThrow('settings changed on disk');
  expect(await store.get('theme-mode')).toBe('dark');
});

it('does not share objects across get/set or with an in-flight save', async () => {
  mocks.invoke
    .mockResolvedValueOnce({ values: { shortcuts: { save: 'Ctrl+S' } }, revision: 'old' })
    .mockResolvedValueOnce({ revision: 'new' });
  const store = await loadSettingsStore();
  const read = await store.get<{ save: string }>('shortcuts');
  read!.save = 'bad';
  expect(await store.get('shortcuts')).toEqual({ save: 'Ctrl+S' });
  const next = { save: 'Alt+S' };
  await store.set('shortcuts', next);
  next.save = 'bad';
  await store.save();
  expect(mocks.invoke.mock.calls[1][1]).toEqual({
    values: { shortcuts: { save: 'Alt+S' } },
    expectedRevision: 'old',
  });
});

it('rejects oversized or unserializable set before changing the in-memory settings', async () => {
  mocks.invoke.mockResolvedValueOnce({ values: { theme: 'light' }, revision: null });
  const store = await loadSettingsStore();
  await expect(store.set('theme', 'x'.repeat(LIMITS.settingsFileBytes))).rejects.toThrow();
  await expect(store.set('theme', undefined)).rejects.toThrow();
  await expect(store.set('theme', 1n)).rejects.toThrow();
  expect(await store.get('theme')).toBe('light');
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('load_settings');
});

it('serializes overlapping saves and captures each requested settings snapshot', async () => {
  let finish!: (result: { revision: string }) => void;
  mocks.invoke
    .mockResolvedValueOnce({ values: {}, revision: null })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ revision: 'second' });
  const store = await loadSettingsStore();
  await store.set('theme', 'light');
  const first = store.save();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await store.set('theme', 'dark');
  const second = store.save();
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  finish({ revision: 'first' });
  await Promise.all([first, second]);
  expect(mocks.invoke.mock.calls.slice(1)).toEqual([
    ['save_settings', { values: { theme: 'light' }, expectedRevision: null }],
    ['save_settings', { values: { theme: 'dark' }, expectedRevision: 'first' }],
  ]);
});
