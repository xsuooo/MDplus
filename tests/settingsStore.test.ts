import { beforeEach, expect, it, vi } from 'vitest';
import { loadSettingsStore } from '../src/services/settingsStore';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
beforeEach(() => vi.clearAllMocks());

it('loads only the fixed native settings resource without a caller-controlled path', async () => {
  mocks.invoke.mockResolvedValueOnce(42).mockResolvedValueOnce(['dark', true]);
  const store = await loadSettingsStore();
  expect(await store.get('theme-mode')).toBe('dark');
  await store.set('theme-mode', 'system');
  await store.save();
  expect(mocks.invoke.mock.calls).toEqual([
    ['load_settings'],
    ['plugin:store|get', { rid: 42, key: 'theme-mode' }],
    ['plugin:store|set', { rid: 42, key: 'theme-mode', value: 'system' }],
    ['plugin:store|save', { rid: 42 }],
  ]);
});

it('propagates a failed native load without creating a usable Store', async () => {
  mocks.invoke.mockRejectedValue(new Error('damaged settings'));
  await expect(loadSettingsStore()).rejects.toThrow('damaged settings');
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('load_settings');
});
