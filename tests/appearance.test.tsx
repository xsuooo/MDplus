// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPEARANCES,
  APPEARANCE_STORAGE_KEY,
  normalizeAppearance,
  readAppearance,
  writeAppearance,
} from '../src/lib/appearance';
import { useAppearance } from '../src/hooks/useAppearance';

let storage: Pick<Storage, 'getItem' | 'setItem'>;
beforeEach(() => {
  // Match the project's deterministic storage fixture, including on Node 26.
  const entries = new Map<string, string>();
  storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
  vi.stubGlobal('localStorage', storage);
  delete document.documentElement.dataset.appearance;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.appearance;
  delete document.documentElement.dataset.theme;
});

describe('display-only material preferences', () => {
  it('accepts only the three shipped materials and defaults to Folio', () => {
    for (const material of APPEARANCES) expect(normalizeAppearance(material.id)).toBe(material.id);
    for (const value of [undefined, null, '', 'unknown', 'FOLIO', {}, 7])
      expect(normalizeAppearance(value)).toBe('folio');
  });

  it('reads and writes each choice using a separate local preference', () => {
    expect(readAppearance()).toBe('folio');
    for (const material of APPEARANCES) {
      writeAppearance(material.id);
      expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe(material.id);
      expect(readAppearance()).toBe(material.id);
    }
    localStorage.setItem(APPEARANCE_STORAGE_KEY, 'removed-style');
    expect(readAppearance()).toBe('folio');
  });

  it('does not let unavailable local storage interrupt writing', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readAppearance()).toBe('folio');
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    expect(() => writeAppearance('prism')).not.toThrow();
  });

  it('applies the stored material before paint without changing theme or fonts', () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, 'nocturne');
    localStorage.setItem('mdplus-body-font', 'wenkai');
    document.documentElement.dataset.theme = 'dark';
    const write = vi.spyOn(storage, 'setItem');
    const hook = renderHook(() => useAppearance());
    expect(hook.result.current.appearance).toBe('nocturne');
    expect(document.documentElement.dataset.appearance).toBe('nocturne');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('mdplus-body-font')).toBe('wenkai');
    expect(write).not.toHaveBeenCalled();
    act(() => hook.result.current.changeAppearance('prism'));
    expect(document.documentElement.dataset.appearance).toBe('prism');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(write).toHaveBeenCalledExactlyOnceWith(APPEARANCE_STORAGE_KEY, 'prism');
  });
});
