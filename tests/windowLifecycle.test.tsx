// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_PERSIST_MS } from '../src/config/constants';
import type { WindowState } from '../src/lib/windowState';

const mocks = vi.hoisted(() => ({
  native: true,
  visible: false,
  maximized: false,
  size: { width: 1200, height: 800 },
  position: { x: 360, y: 120 },
  state: { width: 980, height: 680, x: 70, y: 50, maximized: false } as WindowState,
  getState: vi.fn(),
  saveState: vi.fn(),
  setSize: vi.fn(),
  setPosition: vi.fn(),
  maximize: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  resizeListeners: new Set<() => void>(),
  moveListeners: new Set<() => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => mocks.native }));
vi.mock('../src/lib/store', () => ({
  getWindowState: () => mocks.getState(),
  setWindowState: (state: WindowState) => mocks.saveState(state),
}));
vi.mock('@tauri-apps/api/window', () => ({
  PhysicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  availableMonitors: async () => [
    { workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } } },
  ],
  getCurrentWindow: () => ({
    isVisible: async () => mocks.visible,
    isMinimized: async () => false,
    isMaximized: async () => mocks.maximized,
    innerSize: async () => ({ ...mocks.size }),
    outerPosition: async () => ({ ...mocks.position }),
    setSize: (size: { width: number; height: number }) => mocks.setSize(size),
    setPosition: (position: { x: number; y: number }) => mocks.setPosition(position),
    maximize: () => mocks.maximize(),
    unminimize: async () => {},
    show: () => mocks.show(),
    setFocus: () => mocks.focus(),
    onResized: async (listener: () => void) => {
      mocks.resizeListeners.add(listener);
      return () => mocks.resizeListeners.delete(listener);
    },
    onMoved: async (listener: () => void) => {
      mocks.moveListeners.add(listener);
      return () => mocks.moveListeners.delete(listener);
    },
  }),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let step = 0; step < 24; step++) await Promise.resolve();
}

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let originalFonts: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.native = true;
  mocks.visible = false;
  mocks.maximized = false;
  mocks.size = { width: 1200, height: 800 };
  mocks.position = { x: 360, y: 120 };
  mocks.state = { width: 980, height: 680, x: 70, y: 50, maximized: false };
  mocks.resizeListeners.clear();
  mocks.moveListeners.clear();
  mocks.getState.mockReset().mockImplementation(async () => mocks.state);
  mocks.saveState.mockReset().mockResolvedValue(undefined);
  mocks.setSize.mockReset().mockImplementation(async (size) => {
    mocks.size = { width: size.width, height: size.height };
  });
  mocks.setPosition.mockReset().mockImplementation(async (position) => {
    mocks.position = { x: position.x, y: position.y };
  });
  mocks.maximize.mockReset().mockImplementation(async () => {
    mocks.maximized = true;
  });
  mocks.show.mockReset().mockImplementation(async () => {
    mocks.visible = true;
  });
  mocks.focus.mockReset().mockResolvedValue(undefined);
  originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: new Promise<void>(() => {}) },
  });
  frames.clear();
  nextFrame = 0;
  // A hidden WebView can stop frame delivery; callbacks deliberately never run.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
});

describe('window lifecycle startup', () => {
  it('waits for placement, preferences and explicit font loads before reveal and persistence, even without frame delivery', async () => {
    const stateRead = deferred<WindowState>();
    const maximize = deferred<void>();
    const fonts = deferred<FontFace[]>();
    const load = vi.fn(() => fonts.promise);
    mocks.getState.mockImplementation(() => stateRead.promise);
    mocks.maximize.mockImplementation(async () => {
      await maximize.promise;
      mocks.maximized = true;
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load, ready: new Promise<void>(() => {}) },
    });
    const { useWindowLifecycle } = await import('../src/hooks/useWindowLifecycle');
    const hook = renderHook(({ ready }) => useWindowLifecycle(ready), {
      initialProps: { ready: false },
    });
    await act(flush);
    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(hook.result.current.windowReady).toBe(false);

    await act(async () => {
      for (const listener of mocks.resizeListeners) listener();
      await vi.advanceTimersByTimeAsync(WINDOW_PERSIST_MS + 1);
      await flush();
    });
    expect(mocks.saveState).not.toHaveBeenCalled();
    stateRead.resolve({ ...mocks.state, maximized: true });
    await act(flush);
    expect(mocks.maximize).toHaveBeenCalledTimes(1);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.saveState).not.toHaveBeenCalled();

    maximize.resolve();
    await act(flush);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    hook.rerender({ ready: true });
    await act(flush);
    expect(load).toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.saveState).not.toHaveBeenCalled();
    fonts.resolve([]);
    await act(flush);
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(hook.result.current.windowReady).toBe(true);

    mocks.maximized = false;
    mocks.size = { width: 1100, height: 760 };
    mocks.position = { x: 100, y: 60 };
    expect(mocks.resizeListeners.size).toBe(1);
    expect(mocks.moveListeners.size).toBe(1);
    await act(async () => {
      for (const listener of mocks.resizeListeners) listener();
      for (const listener of mocks.moveListeners) listener();
      await vi.advanceTimersByTimeAsync(WINDOW_PERSIST_MS + 1);
      await flush();
    });
    expect(mocks.saveState).toHaveBeenCalledTimes(1);
    expect(mocks.saveState).toHaveBeenCalledWith({
      width: 1100,
      height: 760,
      x: 100,
      y: 60,
      maximized: false,
    });
  });

  it('restores and reveals once through StrictMode effect cleanup and replay', async () => {
    const { useWindowLifecycle } = await import('../src/hooks/useWindowLifecycle');
    const hook = renderHook(() => useWindowLifecycle(true), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });
    await act(flush);
    expect(hook.result.current.windowReady).toBe(true);
    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.setSize).toHaveBeenCalledTimes(1);
    expect(mocks.setPosition).toHaveBeenCalledTimes(1);
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(mocks.resizeListeners.size).toBe(1);
    expect(mocks.moveListeners.size).toBe(1);
    hook.unmount();
    expect(mocks.resizeListeners.size).toBe(0);
    expect(mocks.moveListeners.size).toBe(0);
  });

  it('does not reveal or register persistence if the app unmounts while fonts are loading', async () => {
    const fonts = deferred<FontFace[]>();
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: () => fonts.promise, ready: new Promise<void>(() => {}) },
    });
    const { useWindowLifecycle } = await import('../src/hooks/useWindowLifecycle');
    const hook = renderHook(() => useWindowLifecycle(true));
    await act(flush);
    hook.unmount();
    fonts.resolve([]);
    await act(flush);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.focus).not.toHaveBeenCalled();
    expect(mocks.resizeListeners.size).toBe(0);
    expect(mocks.moveListeners.size).toBe(0);
  });

  it('still reveals when the font API throws synchronously', async () => {
    const error = new Error('font loading unavailable');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = vi.fn(() => {
      throw error;
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load, ready: new Promise<void>(() => {}) },
    });
    const { useWindowLifecycle } = await import('../src/hooks/useWindowLifecycle');
    const hook = renderHook(() => useWindowLifecycle(true));
    await act(flush);
    expect(load).toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.any(String), error);
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(hook.result.current.windowReady).toBe(true);
  });

  it('waits for explicit font requests and still reveals if they reject while font layout readiness remains pending', async () => {
    const requestedFonts = deferred<FontFace[]>();
    const load = vi.fn(() => requestedFonts.promise);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load, ready: new Promise<void>(() => {}) },
    });
    const { useWindowLifecycle } = await import('../src/hooks/useWindowLifecycle');
    const hook = renderHook(() => useWindowLifecycle(true));
    await act(flush);
    expect(load).toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
    await act(async () => {
      requestedFonts.reject(new Error('font download failed'));
      await flush();
    });
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(hook.result.current.windowReady).toBe(true);
  });

  it('is immediately ready in a browser without calling native window APIs', async () => {
    mocks.native = false;
    const { useWindowLifecycle } = await import('../src/hooks/useWindowLifecycle');
    const hook = renderHook(() => useWindowLifecycle(false));
    await act(flush);
    expect(hook.result.current.windowReady).toBe(true);
    expect(mocks.getState).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.focus).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it('reveals the error boundary when App rendering fails before lifecycle effects mount', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ErrorBoundary } = await import('../src/components/ErrorBoundary');
    function BrokenApp(): ReactNode {
      throw new Error('startup render failed');
    }
    const fallback = render(
      <ErrorBoundary>
        <BrokenApp />
      </ErrorBoundary>,
    );
    await act(flush);
    expect(fallback.getByRole('heading', { name: '出了点问题' })).toBeTruthy();
    expect(fallback.getByText('startup render failed')).toBeTruthy();
    expect(mocks.setSize).toHaveBeenCalledTimes(1);
    expect(mocks.setPosition).toHaveBeenCalledTimes(1);
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
  });
});
