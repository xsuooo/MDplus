export interface WindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSnapshot {
  minimized: boolean;
  maximized: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
}

/** 与 src-tauri/tauri.conf.json 的 window 配置一致,由 tests/windowState.test.ts 守护。 */
export const DEFAULT_WINDOW_WIDTH = 1200;
export const DEFAULT_WINDOW_HEIGHT = 800;
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;

/** 最小化窗口在 Windows 上上报的坐标(窗口本来在 -32000,-32000)。 */
const SENTINEL_COORDINATE = -30_000;
/** 标题栏区域至少要有这么多像素落在显示器工作区内,才算窗口可见。 */
const MIN_VISIBLE = 80;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSentinel(value: number): boolean {
  return value <= SENTINEL_COORDINATE;
}

/**
 * 校验持久化的窗口状态。哨兵坐标、非有限值、缺失字段和过小尺寸都视为无效,
 * 返回 null 让调用方回落到默认窗口。负坐标本身合法(左侧/上方副屏)。
 */
export function sanitizeWindowState(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;
  const { width, height, x, y } = source;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT) return null;
  if (isSentinel(x) || isSentinel(y)) return null;
  return { width, height, x, y, maximized: source.maximized === true };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function isVisibleOn(state: WindowState, display: DisplayWorkArea): boolean {
  const titleBar = { x: state.x, y: state.y, width: state.width, height: MIN_VISIBLE };
  return overlapArea(titleBar, display) > 0;
}

/**
 * 把完全落在所有显示器工作区之外的窗口拉回可见位置。
 * 有多块显示器时(可能含负坐标),优先保留与窗口重叠最多的那块。
 */
export function clampToVisibleDisplays(
  state: WindowState,
  displays: readonly DisplayWorkArea[],
): WindowState {
  const usable = displays.filter(
    (display) => isFiniteNumber(display.x) && isFiniteNumber(display.y)
      && display.width > 0 && display.height > 0,
  );
  if (usable.length === 0) return state;
  if (usable.some((display) => isVisibleOn(state, display))) return state;

  let target = usable[0]!;
  let best = overlapArea(state, target);
  for (const display of usable.slice(1)) {
    const area = overlapArea(state, display);
    if (area > best) {
      best = area;
      target = display;
    }
  }

  const width = Math.min(state.width, target.width);
  const height = Math.min(state.height, target.height);
  return {
    ...state,
    width,
    height,
    x: Math.max(target.x, Math.min(state.x, target.x + target.width - width)),
    y: Math.max(target.y, Math.min(state.y, target.y + target.height - height)),
  };
}

/**
 * 决定这次是否把窗口状态写回设置。
 * 最小化期间窗口上报的是哨兵坐标和极小尺寸,写回会把上次有效状态覆盖成不可用的值。
 */
export function windowStateToPersist(
  snapshot: WindowSnapshot,
  displays: readonly DisplayWorkArea[] = [],
): WindowState | null {
  if (snapshot.minimized) return null;
  const candidate = sanitizeWindowState({
    width: snapshot.width,
    height: snapshot.height,
    x: snapshot.x,
    y: snapshot.y,
    maximized: snapshot.maximized,
  });
  return candidate ? clampToVisibleDisplays(candidate, displays) : null;
}
