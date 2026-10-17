/** 一次手势内累计到这么多像素才切一格。 */
export const TAB_WHEEL_STEP = 48;
/** 累计超过这个量就锁定方向,之后小幅反向抖动不再改判。 */
export const TAB_WHEEL_DIRECTION_LOCK = 6;
/** 超过这个静默间隔视为新手势。 */
export const TAB_WHEEL_GESTURE_IDLE_MS = 140;
/**
 * 单个事件达到这个量就当作一个"滚轮档位"(鼠标一格实测 100px)。
 * 档位是离散的:每一格都必须独立生效,不能因为上一格刚切过就被吞掉。
 */
export const TAB_WHEEL_NOTCH = 60;

export interface TabWheelState {
  /** 当前手势内的累计位移(带方向) */
  accumulated: number;
  /** 当前手势已锁定的方向,0 表示还没锁定 */
  direction: -1 | 0 | 1;
  lastEventAt: number;
  /** 本次连续手势是否已经切过一次 */
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
 * 纯计算:每次 wheel 事件传入当前状态与时间戳,返回是否切换、切哪边,以及下一份状态。
 *
 * 两类输入分开处理:
 * - 离散档位(单个事件就 ≥ TAB_WHEEL_NOTCH,鼠标一格 100px):每格立刻切一格,
 *   方向取该事件自身的符号。这样连续两格不会因为"上一次刚切过"被吞掉,
 *   也就不会出现"滚了两下只动一格、再反向时看着像反了"。
 * - 连续小步(触控板/平滑滚动):按手势累计,首次明确方向即锁定,一次手势最多切一格;
 *   反向累计明确(而非抖动)时立刻开启新手势,保证停顿或转向后能马上响应。
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
  if (deltaY === 0) return { state: { ...state, lastEventAt: now }, direction: 0 };
  // 横向滑动优先交给标签条自己滚动
  if (Math.abs(deltaX) > Math.abs(deltaY) * 1.5) return { state: { ...state, lastEventAt: now }, direction: 0 };

  const sign: -1 | 1 = deltaY > 0 ? 1 : -1;

  // 离散档位:每格独立生效,并结束上一段连续手势
  if (Math.abs(deltaY) >= TAB_WHEEL_NOTCH) {
    return {
      state: { accumulated: 0, direction: sign, lastEventAt: now, consumed: true },
      direction: sign,
    };
  }

  const base: TabWheelState = isIdle(state, now)
    ? { accumulated: 0, direction: 0, lastEventAt: now, consumed: false }
    : { ...state, lastEventAt: now };

  let accumulated = base.accumulated;
  let direction = base.direction;

  if (direction !== 0 && sign !== direction) {
    if (base.consumed) {
      // 已经切过一格,又来一个明确的反向小步:这是转向,不是抖动,直接开新手势
      return {
        state: { accumulated: deltaY, direction: sign, lastEventAt: now, consumed: false },
        direction: 0,
      };
    }
    // 尚未切换:当作抖动丢弃
    return { state: base, direction: 0 };
  }

  accumulated += deltaY;
  if (direction === 0 && Math.abs(accumulated) >= TAB_WHEEL_DIRECTION_LOCK) direction = sign;
  if (base.consumed) return { state: { ...base, accumulated, direction }, direction: 0 };
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
