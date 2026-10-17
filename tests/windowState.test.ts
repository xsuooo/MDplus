import { describe, expect, it } from 'vitest';
import conf from '../src-tauri/tauri.conf.json';
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  clampToVisibleDisplays,
  sanitizeWindowState,
  windowStateToPersist,
  type DisplayWorkArea,
  type WindowState,
} from '../src/lib/windowState';

const primary: DisplayWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };
/** 左侧副屏:合法负坐标 */
const leftScreen: DisplayWorkArea = { x: -1920, y: 0, width: 1920, height: 1040 };
const valid: WindowState = { width: 1200, height: 800, x: 100, y: 80, maximized: false };

describe('window state defaults', () => {
  it('matches the window size declared in tauri.conf.json', () => {
    const declared = (conf as { app: { windows: Array<Record<string, number>> } }).app.windows[0]!;
    expect(DEFAULT_WINDOW_WIDTH).toBe(declared.width);
    expect(DEFAULT_WINDOW_HEIGHT).toBe(declared.height);
    expect(MIN_WINDOW_WIDTH).toBe(declared.minWidth);
    expect(MIN_WINDOW_HEIGHT).toBe(declared.minHeight);
  });
});

describe('sanitizeWindowState', () => {
  it('keeps a valid state and normalizes maximized', () => {
    expect(sanitizeWindowState({ ...valid, maximized: true })).toEqual({ ...valid, maximized: true });
    expect(sanitizeWindowState({ ...valid, maximized: 'yes' })).toEqual(valid);
  });

  it('rejects the minimized sentinel coordinates written by Windows', () => {
    expect(sanitizeWindowState({ width: 144, height: 19, x: -32000, y: -32000, maximized: false })).toBeNull();
    expect(sanitizeWindowState({ ...valid, x: -32000 })).toBeNull();
    expect(sanitizeWindowState({ ...valid, y: -32000 })).toBeNull();
  });

  it('rejects zero, negative and undersized windows', () => {
    expect(sanitizeWindowState({ ...valid, width: 0 })).toBeNull();
    expect(sanitizeWindowState({ ...valid, height: -800 })).toBeNull();
    expect(sanitizeWindowState({ ...valid, width: MIN_WINDOW_WIDTH - 1 })).toBeNull();
    expect(sanitizeWindowState({ ...valid, height: MIN_WINDOW_HEIGHT - 1 })).toBeNull();
  });

  it('rejects non-finite and missing fields', () => {
    expect(sanitizeWindowState({ ...valid, x: Number.NaN })).toBeNull();
    expect(sanitizeWindowState({ ...valid, y: Number.POSITIVE_INFINITY })).toBeNull();
    expect(sanitizeWindowState({ width: 1200, height: 800, x: 0 })).toBeNull();
    expect(sanitizeWindowState(null)).toBeNull();
    expect(sanitizeWindowState('1200x800')).toBeNull();
  });

  it('accepts genuine negative coordinates from a display to the left', () => {
    expect(sanitizeWindowState({ ...valid, x: -1800, y: 40 })).toEqual({ ...valid, x: -1800, y: 40 });
  });
});

describe('clampToVisibleDisplays', () => {
  it('leaves a window alone when it is visible', () => {
    expect(clampToVisibleDisplays(valid, [primary])).toEqual(valid);
  });

  it('keeps a window on the left-hand display instead of pulling it to the primary one', () => {
    const onLeft: WindowState = { ...valid, x: -1800, y: 40 };
    expect(clampToVisibleDisplays(onLeft, [primary, leftScreen])).toEqual(onLeft);
  });

  it('moves a window that is entirely off every display into a visible area', () => {
    const stray: WindowState = { ...valid, x: 9000, y: 9000 };
    const placed = clampToVisibleDisplays(stray, [primary, leftScreen]);
    expect(placed.x).toBeGreaterThanOrEqual(primary.x);
    expect(placed.y).toBeGreaterThanOrEqual(primary.y);
    expect(placed.x + placed.width).toBeLessThanOrEqual(primary.x + primary.width);
    expect(placed.y + placed.height).toBeLessThanOrEqual(primary.y + primary.height);
  });

  it('shrinks a window that is larger than the target display', () => {
    const huge: WindowState = { width: 4000, height: 3000, x: 12000, y: 12000, maximized: false };
    const placed = clampToVisibleDisplays(huge, [primary]);
    expect(placed.width).toBe(primary.width);
    expect(placed.height).toBe(primary.height);
  });

  it('returns the state unchanged when no display information is available', () => {
    expect(clampToVisibleDisplays(valid, [])).toEqual(valid);
  });
});

describe('windowStateToPersist', () => {
  it('refuses to persist while the window is minimized', () => {
    expect(windowStateToPersist(
      { minimized: true, maximized: false, width: 144, height: 19, x: -32000, y: -32000 },
      [primary],
    )).toBeNull();
  });

  it('refuses to persist a minimized-size snapshot even if the flag is missing', () => {
    expect(windowStateToPersist(
      { minimized: false, maximized: false, width: 144, height: 19, x: 10, y: 10 },
      [primary],
    )).toBeNull();
  });

  it('persists a valid snapshot clamped into a visible display', () => {
    expect(windowStateToPersist(
      { minimized: false, maximized: false, width: 1200, height: 800, x: 9000, y: 9000 },
      [primary],
    )).toEqual({ width: 1200, height: 800, x: 720, y: 240, maximized: false });
  });

  it('keeps the maximized flag and existing coordinates', () => {
    expect(windowStateToPersist(
      { minimized: false, maximized: true, width: 1200, height: 800, x: 100, y: 80 },
      [primary],
    )).toEqual({ width: 1200, height: 800, x: 100, y: 80, maximized: true });
  });
});
