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
