import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { DEFAULT_SHORTCUTS, type ShortcutBindings } from '../lib/shortcuts';
import {
  loadPreferences,
  setOutlineOpen as saveOutlineOpen,
  saveShortcutBindings,
  setSourceModePref,
  setThemeMode,
} from '../lib/store';
import { applyTheme } from '../lib/theme';
import type { ThemeMode } from '../lib/types';

type Preference = 'theme' | 'source' | 'outline' | 'shortcuts';
interface PendingWrite {
  run: () => Promise<void>;
  failed: boolean;
}

/** Apply startup preferences once, preserving newer user choices and failed writes for retry. */
export function usePreferences(setSourceMode: (enabled: boolean) => void) {
  const [themeMode, setTheme] = useState<ThemeMode>('light');
  const [outlineOpen, setOutline] = useState(false);
  const [shortcuts, setShortcuts] = useState<ShortcutBindings>(DEFAULT_SHORTCUTS);
  const [settingsError, setSettingsError] = useState<'load' | 'save' | null>(null);
  const changed = useRef(new Set<Preference>());
  const pending = useRef(new Map<Preference, PendingWrite>());
  const loadFailed = useRef(false);
  const loadVersion = useRef(0);
  const alive = useRef(true);
  const outline = useRef(false);

  const refreshError = useCallback(() => {
    if (alive.current)
      setSettingsError(
        [...pending.current.values()].some((write) => write.failed)
          ? 'save'
          : loadFailed.current
            ? 'load'
            : null,
      );
  }, []);
  const read = useCallback(async () => {
    if (!isTauri()) return;
    const version = ++loadVersion.current;
    try {
      const preferences = await loadPreferences();
      if (!alive.current || version !== loadVersion.current) return;
      if (!changed.current.has('theme')) setTheme(preferences.themeMode);
      if (!changed.current.has('source')) setSourceMode(preferences.sourceMode);
      if (!changed.current.has('outline')) {
        outline.current = preferences.outlineOpen;
        setOutline(preferences.outlineOpen);
      }
      if (!changed.current.has('shortcuts')) setShortcuts(preferences.shortcuts);
      loadFailed.current = false;
    } catch {
      if (!alive.current || version !== loadVersion.current) return;
      loadFailed.current = true;
    }
    refreshError();
  }, [refreshError, setSourceMode]);
  const write = useCallback(
    async (key: Preference, operation: PendingWrite) => {
      try {
        await operation.run();
        if (pending.current.get(key) === operation) pending.current.delete(key);
      } catch {
        operation.failed = true;
      }
      refreshError();
    },
    [refreshError],
  );
  const persist = useCallback(
    (key: Preference, run: () => Promise<void>) => {
      changed.current.add(key);
      if (!isTauri()) return;
      const operation = { run, failed: false };
      pending.current.set(key, operation);
      void write(key, operation);
    },
    [write],
  );
  const retrySettings = useCallback(async () => {
    await Promise.all(
      [...pending.current.entries()].map(([key, operation]) => write(key, operation)),
    );
    if (loadFailed.current) await read();
  }, [read, write]);

  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [read]);
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      applyTheme(themeMode === 'system' ? (media.matches ? 'dark' : 'light') : themeMode);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [themeMode]);

  const changeThemeMode = useCallback(
    (mode: ThemeMode) => {
      setTheme(mode);
      persist('theme', () => setThemeMode(mode));
    },
    [persist],
  );
  const changeOutlineOpen = useCallback(
    (value: boolean | ((previous: boolean) => boolean)) => {
      const open = typeof value === 'function' ? value(outline.current) : value;
      outline.current = open;
      setOutline(open);
      persist('outline', () => saveOutlineOpen(open));
    },
    [persist],
  );
  const changeShortcuts = useCallback(
    (bindings: ShortcutBindings) => {
      setShortcuts(bindings);
      persist('shortcuts', () => saveShortcutBindings(bindings));
    },
    [persist],
  );
  const changeSourcePreference = useCallback(
    (enabled: boolean) => {
      persist('source', () => setSourceModePref(enabled));
    },
    [persist],
  );
  return {
    themeMode,
    outlineOpen,
    shortcuts,
    settingsError,
    retrySettings,
    changeThemeMode,
    changeOutlineOpen,
    changeShortcuts,
    changeSourcePreference,
  };
}
