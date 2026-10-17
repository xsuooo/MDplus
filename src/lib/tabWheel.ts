/** 一次滚轮手势要累计到这么多像素才切一个标签。 */
export const TAB_WHEEL_THRESHOLD = 48;
/** 两次切换之间的最短间隔,避免高精度滚轮一次滑动连跳多个标签。 */
export const TAB_WHEEL_COOLDOWN_MS = 200;

export interface TabWheelState {
  accumulated: number;
  lastSwitchAt: number;
}

export const TAB_WHEEL_INITIAL: TabWheelState = { accumulated: 0, lastSwitchAt: 0 };

/** 1 = 下一个标签(滚轮向下),-1 = 上一个标签,0 = 本次不切换 */
export type TabWheelDirection = -1 | 0 | 1;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
}

/**
 * 只做纯计算:调用方每次 wheel 事件把当前状态和事件时间丢进来,
 * 拿回"是否切换、切哪边"以及下一份状态。
 */
export function wheelStep(
  state: TabWheelState,
  event: WheelLike,
  tabCount: number,
  now: number,
): { state: TabWheelState; direction: TabWheelDirection } {
  if (tabCount <= 1) {
    return { state: { ...TAB_WHEEL_INITIAL, lastSwitchAt: state.lastSwitchAt }, direction: 0 };
  }
  const deltaY = Number.isFinite(event.deltaY) ? event.deltaY : 0;
  const deltaX = Number.isFinite(event.deltaX) ? event.deltaX : 0;
  // 横向滚动(触控板横扫、Shift+滚轮)留给标签栏自己,不抢。
  if (Math.abs(deltaX) >= Math.abs(deltaY)) return { state, direction: 0 };
  if (deltaY === 0) return { state, direction: 0 };

  // 冷却期内的事件直接丢弃(不再累计),这样一次手势最多走一格;
  // 手势停下来后要重新累计到阈值才会再次切换。
  if (now - state.lastSwitchAt < TAB_WHEEL_COOLDOWN_MS) {
    return { state: { accumulated: 0, lastSwitchAt: state.lastSwitchAt }, direction: 0 };
  }
  const accumulated = state.accumulated + deltaY;
  if (Math.abs(accumulated) < TAB_WHEEL_THRESHOLD) {
    return { state: { accumulated, lastSwitchAt: state.lastSwitchAt }, direction: 0 };
  }
  return {
    state: { accumulated: 0, lastSwitchAt: now },
    direction: accumulated > 0 ? 1 : -1,
  };
}

/** 首尾循环的下标计算;标签数 <= 1 或当前下标无效时返回 null(不切换)。 */
export function cycleTabIndex(currentIndex: number, count: number, delta: number): number | null {
  if (count <= 1) return null;
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= count) return null;
  return (currentIndex + delta + count) % count;
}
