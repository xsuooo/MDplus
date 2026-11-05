// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreferences } from '../src/hooks/usePreferences';
import { DEFAULT_SHORTCUTS } from '../src/lib/shortcuts';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  theme: vi.fn(),
  source: vi.fn(),
  outline: vi.fn(),
  shortcuts: vi.fn(),
}));
vi.mock('../src/lib/store', () => ({
  loadPreferences: mocks.load,
  setThemeMode: mocks.theme,
  setSourceModePref: mocks.source,
  setOutlineOpen: mocks.outline,
  saveShortcutBindings: mocks.shortcuts,
}));
vi.mock('../src/lib/theme', () => ({ applyTheme: vi.fn() }));
const saved = () => ({
  themeMode: 'dark' as const,
  sourceMode: true,
  outlineOpen: true,
  shortcuts: DEFAULT_SHORTCUTS,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue(saved());
  for (const write of [mocks.theme, mocks.source, mocks.outline, mocks.shortcuts])
    write.mockResolvedValue(undefined);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('preference recovery and user choice ordering', () => {
  it('shows a failed read and restores saved values on explicit retry', async () => {
    mocks.load.mockRejectedValueOnce(new Error('busy settings'));
    const setSource = vi.fn();
    const hook = renderHook(() => usePreferences(setSource));
    await act(async () => {});
    expect(hook.result.current.settingsError).toBe('load');
    expect(hook.result.current.themeMode).toBe('light');
    await act(() => hook.result.current.retrySettings());
    expect(hook.result.current.settingsError).toBeNull();
    expect(hook.result.current.themeMode).toBe('dark');
    expect(hook.result.current.outlineOpen).toBe(true);
    expect(setSource).toHaveBeenCalledWith(true);
    expect(mocks.theme).not.toHaveBeenCalled();
  });

  it('does not replace any user choice with a late startup read', async () => {
    const read = deferred<ReturnType<typeof saved>>();
    mocks.load.mockReturnValueOnce(read.promise);
    const setSource = vi.fn();
    const hook = renderHook(() => usePreferences(setSource));
    const bindings = { ...DEFAULT_SHORTCUTS, new: null };
    await act(async () => {
      hook.result.current.changeThemeMode('system');
      hook.result.current.changeOutlineOpen(false);
      hook.result.current.changeShortcuts(bindings);
      hook.result.current.changeSourcePreference(false);
      read.resolve(saved());
    });
    expect(hook.result.current.themeMode).toBe('system');
    expect(hook.result.current.outlineOpen).toBe(false);
    expect(hook.result.current.shortcuts).toEqual(bindings);
    expect(setSource).not.toHaveBeenCalled();
  });

  it('retains a failed write for retry without reverting the selected view', async () => {
    mocks.theme.mockRejectedValueOnce(new Error('disk full'));
    const setSource = vi.fn();
    const hook = renderHook(() => usePreferences(setSource));
    await act(async () => {});
    await act(async () => hook.result.current.changeThemeMode('system'));
    expect(hook.result.current.settingsError).toBe('save');
    expect(hook.result.current.themeMode).toBe('system');
    await act(() => hook.result.current.retrySettings());
    expect(mocks.theme.mock.calls).toEqual([['system'], ['system']]);
    expect(hook.result.current.settingsError).toBeNull();
  });

  it('retries only the newest choice after an older write fails', async () => {
    const old = deferred<void>();
    mocks.theme.mockReturnValueOnce(
      old.promise.then(() => {
        throw new Error('old failure');
      }),
    );
    const setSource = vi.fn();
    const hook = renderHook(() => usePreferences(setSource));
    await act(async () => {});
    await act(async () => {
      hook.result.current.changeThemeMode('light');
      hook.result.current.changeThemeMode('system');
      old.resolve();
    });
    await act(() => hook.result.current.retrySettings());
    expect(mocks.theme.mock.calls).toEqual([['light'], ['system']]);
    expect(hook.result.current.themeMode).toBe('system');
    expect(hook.result.current.settingsError).toBeNull();
  });

  it('does not apply a pending startup read after unmount', async () => {
    const read = deferred<ReturnType<typeof saved>>();
    mocks.load.mockReturnValueOnce(read.promise);
    const setSource = vi.fn();
    const hook = renderHook(() => usePreferences(setSource));
    hook.unmount();
    await act(async () => read.resolve(saved()));
    expect(setSource).not.toHaveBeenCalled();
  });
});
