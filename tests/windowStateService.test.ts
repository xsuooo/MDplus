import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowState } from '../src/lib/windowState';

const mocks = vi.hoisted(() => ({
  native: true,
  visible: false,
  state: null as WindowState | null,
  trace: [] as string[],
  getState: vi.fn(),
  saveState: vi.fn(),
  monitors: vi.fn(),
  isVisible: vi.fn(),
  isMinimized: vi.fn(),
  setSize: vi.fn(),
  setPosition: vi.fn(),
  maximize: vi.fn(),
  unminimize: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
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
  availableMonitors: () => mocks.monitors(),
  getCurrentWindow: () => ({
    isVisible: () => mocks.isVisible(),
    isMinimized: () => mocks.isMinimized(),
    setSize: (size: unknown) => mocks.setSize(size),
    setPosition: (position: unknown) => mocks.setPosition(position),
    maximize: () => mocks.maximize(),
    unminimize: () => mocks.unminimize(),
    show: () => mocks.show(),
    setFocus: () => mocks.focus(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flush() {
  for (let step = 0; step < 24; step++) await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  mocks.native = true;
  mocks.visible = false;
  mocks.state = { width: 980, height: 680, x: 70, y: 50, maximized: false };
  mocks.trace = [];
  mocks.getState.mockReset().mockImplementation(async () => mocks.state);
  mocks.saveState.mockReset().mockResolvedValue(undefined);
  mocks.monitors
    .mockReset()
    .mockResolvedValue([
      { workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } } },
    ]);
  mocks.isVisible.mockReset().mockImplementation(async () => mocks.visible);
  mocks.isMinimized.mockReset().mockResolvedValue(false);
  mocks.setSize.mockReset().mockImplementation(async () => {
    mocks.trace.push('size:complete');
  });
  mocks.setPosition.mockReset().mockImplementation(async () => {
    mocks.trace.push('position:complete');
  });
  mocks.maximize.mockReset().mockImplementation(async () => {
    mocks.trace.push('maximize:complete');
  });
  mocks.unminimize.mockReset().mockImplementation(async () => {
    mocks.trace.push('unminimize');
  });
  mocks.show.mockReset().mockImplementation(async () => {
    mocks.visible = true;
    mocks.trace.push('show');
  });
  mocks.focus.mockReset().mockImplementation(async () => {
    mocks.trace.push('focus');
  });
});

describe('initial window preparation and reveal', () => {
  it('keeps reveal and window-ready pending until resize, positioning and maximization finish', async () => {
    const stateRead = deferred<WindowState>();
    const resize = deferred<void>();
    const maximize = deferred<void>();
    mocks.getState.mockImplementation(() => stateRead.promise);
    mocks.setSize.mockImplementation(async () => {
      mocks.trace.push('size:start');
      await resize.promise;
      mocks.trace.push('size:complete');
    });
    mocks.maximize.mockImplementation(async () => {
      mocks.trace.push('maximize:start');
      await maximize.promise;
      mocks.trace.push('maximize:complete');
    });
    const service = await import('../src/services/windowState');
    let ready = false;
    const windowReady = service.waitForWindowReady().then(() => {
      ready = true;
    });
    const showing = service.showInitialWindow();
    await flush();
    expect(mocks.setSize).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(ready).toBe(false);

    stateRead.resolve({ ...mocks.state!, maximized: true });
    await flush();
    expect(mocks.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 980, height: 680 }),
    );
    expect(mocks.setPosition).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();

    resize.resolve();
    await flush();
    expect(mocks.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 70, y: 50 }));
    expect(mocks.maximize).toHaveBeenCalledTimes(1);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.focus).not.toHaveBeenCalled();
    expect(ready).toBe(false);

    maximize.resolve();
    await showing;
    await windowReady;
    expect(mocks.trace).toEqual([
      'size:start',
      'size:complete',
      'position:complete',
      'maximize:start',
      'maximize:complete',
      'show',
      'focus',
    ]);
    expect(ready).toBe(true);
  });

  it('shares preparation and reveal across concurrent callers without replaying native operations', async () => {
    const stateRead = deferred<WindowState>();
    mocks.getState.mockImplementation(() => stateRead.promise);
    const service = await import('../src/services/windowState');
    const calls = [
      service.prepareWindowState(),
      service.prepareWindowState(),
      service.showInitialWindow(),
      service.showInitialWindow(),
    ];
    await flush();
    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.show).not.toHaveBeenCalled();
    stateRead.resolve(mocks.state!);
    await Promise.all(calls);
    await service.prepareWindowState();
    await service.showInitialWindow();
    expect(mocks.setSize).toHaveBeenCalledTimes(1);
    expect(mocks.setPosition).toHaveBeenCalledTimes(1);
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
  });

  it('preserves a live window on page reload instead of restoring an older saved placement', async () => {
    mocks.visible = true;
    mocks.state!.maximized = true;
    const service = await import('../src/services/windowState');
    await service.showInitialWindow();
    expect(mocks.getState).not.toHaveBeenCalled();
    expect(mocks.monitors).not.toHaveBeenCalled();
    expect(mocks.setSize).not.toHaveBeenCalled();
    expect(mocks.setPosition).not.toHaveBeenCalled();
    expect(mocks.maximize).not.toHaveBeenCalled();
  });

  it('reveals the default window and releases modal waiters after a saved-state read fails', async () => {
    mocks.getState.mockRejectedValue(new Error('settings read failed'));
    const service = await import('../src/services/windowState');
    const windowReady = service.waitForWindowReady();
    await service.showInitialWindow().catch(() => {});
    await windowReady;
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
  });

  it('restores a minimized startup window before focusing it', async () => {
    mocks.isMinimized.mockResolvedValue(true);
    const service = await import('../src/services/windowState');
    await service.showInitialWindow();
    expect(mocks.unminimize).toHaveBeenCalledTimes(1);
    expect(mocks.trace.indexOf('unminimize')).toBeLessThan(mocks.trace.indexOf('focus'));
  });

  it('settles the shared ready signal even when native reveal fails', async () => {
    mocks.show.mockRejectedValue(new Error('window unavailable'));
    const service = await import('../src/services/windowState');
    const windowReady = service.waitForWindowReady();
    await service.showInitialWindow().catch(() => {});
    await windowReady;
    expect(mocks.show).toHaveBeenCalledTimes(1);
  });

  it('does not invoke native window APIs in a browser', async () => {
    mocks.native = false;
    const service = await import('../src/services/windowState');
    await service.prepareWindowState();
    await service.showInitialWindow();
    await service.waitForWindowReady();
    expect(mocks.isVisible).not.toHaveBeenCalled();
    expect(mocks.getState).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.focus).not.toHaveBeenCalled();
  });
});
