/** 一次手势内累计到这么多像素才切一格。 */
export const TAB_WHEEL_STEP = 48;
/** 累计超过这个量就锁定方向,之后反向抖动不再改判。 */
export const TAB_WHEEL_DIRECTION_LOCK = 6;
/** 超过这个静默间隔视为新手势(触控板惯性尾巴不会接到下一次手势上)。 */
export const TAB_WHEEL_GESTURE_IDLE_MS = 140;

export interface TabWheelState {
  /** 当前手势内的累计位移(带方向) */
  accumulated: number;
  /** 当前手势已锁定的方向,0 表示还没锁定 */
  direction: -1 | 0 | 1;
  lastEventAt: number;
  /** 本次手势是否已经切过一次:切过就不再切,直到手势结束 */
  consumed: boolean;
}

export const TAB_WHEEL_INITIAL: TabWheelState = {
  accumulated: 0,
  direction: 0,
  lastEventAt: 0,
  consumed: false,
};

/** 1 = 下一个标签(滚轮向下),-1 = 上一个标签,0 = 本次不切换 */
export type TabWheelDirection = -1 | 0 | 1;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
}

/** 统一成像素:行模式按 16px/行、页模式按 100px/页。 */
export function normalizeWheelDelta(delta: number, deltaMode = 0): number {
  if (!Number.isFinite(delta)) return 0;
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 100;
  return delta;
}

const isIdle = (state: TabWheelState, now: number) => now - state.lastEventAt > TAB_WHEEL_GESTURE_IDLE_MS;

/**
 * 纯计算:每次 wheel 事件传入当前状态与时间戳,返回"是否切换、切哪边"和下一份状态。
 *
 * 方向稳定性来自两点:手势内第一次出现明确方向时锁定它(反向抖动被忽略),
 * 以及一次手势只允许切一格(consumed),而不是用固定延时去压事件。
 */
export function wheelStep(
  state: TabWheelState,
  event: WheelLike,
  tabCount: number,
  now: number,
): { state: TabWheelState; direction: TabWheelDirection } {
  if (tabCount <= 1) return { state: { ...TAB_WHEEL_INITIAL, lastEventAt: now }, direction: 0 };

  const deltaY = normalizeWheelDelta(event.deltaY, event.deltaMode ?? 0);
  const deltaX = normalizeWheelDelta(event.deltaX, event.deltaMode ?? 0);

  // 新手势:清掉上一次手势的累计与锁定
  const base: TabWheelState = isIdle(state, now)
    ? { accumulated: 0, direction: 0, lastEventAt: now, consumed: false }
    : { ...state, lastEventAt: now };

  if (deltaY === 0) return { state: base, direction: 0 };
  // 横向滑动优先交给标签条自己滚动
  if (Math.abs(deltaX) > Math.abs(deltaY) * 1.5) return { state: base, direction: 0 };
  // 本次手势已经切过了:剩下的(含惯性)一律忽略
  if (base.consumed) return { state: base, direction: 0 };

  const sign: -1 | 1 = deltaY > 0 ? 1 : -1;
  let direction = base.direction;
  let accumulated = base.accumulated;

  if (direction !== 0 && sign !== direction) {
    // 手势内反向抖动:丢掉,不改判
    return { state: base, direction: 0 };
  }
  accumulated += deltaY;
  if (direction === 0 && Math.abs(accumulated) >= TAB_WHEEL_DIRECTION_LOCK) direction = sign;

  if (direction !== 0 && Math.abs(accumulated) >= TAB_WHEEL_STEP) {
    return {
      state: { accumulated: 0, direction, lastEventAt: now, consumed: true },
      direction,
    };
  }
  return { state: { ...base, accumulated, direction }, direction: 0 };
}

/** 首尾循环的下标计算;标签数 <= 1 或当前下标无效时返回 null(不切换)。 */
export function cycleTabIndex(currentIndex: number, count: number, delta: number): number | null {
  if (count <= 1) return null;
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= count) return null;
  return (currentIndex + delta + count) % count;
}
