import { describe, expect, it } from 'vitest';
import {
  TAB_WHEEL_DIRECTION_LOCK,
  TAB_WHEEL_GESTURE_IDLE_MS,
  TAB_WHEEL_INITIAL,
  TAB_WHEEL_STEP,
  cycleTabIndex,
  normalizeWheelDelta,
  wheelStep,
  type TabWheelState,
} from '../src/lib/tabWheel';

const wheel = (deltaY: number, deltaX = 0, deltaMode = 0) => ({ deltaX, deltaY, deltaMode });
const T0 = 10_000;

/** 模拟一段手势:每帧间隔 stepMs,返回每次事件的切换方向。 */
function gesture(
  deltas: number[],
  tabCount = 4,
  stepMs = 16,
  start = T0,
  initial: TabWheelState = { ...TAB_WHEEL_INITIAL },
) {
  let state = initial;
  const directions: number[] = [];
  deltas.forEach((delta, i) => {
    const result = wheelStep(state, wheel(delta), tabCount, start + i * stepMs);
    state = result.state;
    directions.push(result.direction);
  });
  return { state, directions };
}

describe('normalizeWheelDelta', () => {
  it('converts line and page deltas to pixels', () => {
    expect(normalizeWheelDelta(3)).toBe(3);
    expect(normalizeWheelDelta(3, 1)).toBe(48);
    expect(normalizeWheelDelta(1, 2)).toBe(100);
  });

  it('drops non-finite deltas', () => {
    expect(normalizeWheelDelta(Number.NaN)).toBe(0);
    expect(normalizeWheelDelta(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('wheelStep direction', () => {
  it('goes to the next tab when scrolling down', () => {
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(120), 4, T0).direction).toBe(1);
  });

  it('goes to the previous tab when scrolling up', () => {
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(-120), 4, T0).direction).toBe(-1);
  });

  it('ignores a single tab or no tabs', () => {
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(500), 1, T0).direction).toBe(0);
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(500), 0, T0).direction).toBe(0);
  });

  it('respects line-mode deltas from a classic wheel', () => {
    // 行模式一次 3 行 = 48px,正好一格
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(3, 0, 1), 4, T0).direction).toBe(1);
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(-3, 0, 1), 4, T0).direction).toBe(-1);
  });

  it('leaves horizontal scrolling to the tab strip', () => {
    const result = wheelStep(TAB_WHEEL_INITIAL, wheel(4, 120), 4, T0);
    expect(result.direction).toBe(0);
  });
});

describe('wheelStep gesture handling', () => {
  it('accumulates a high-resolution trackpad gesture instead of switching per event', () => {
    const { directions } = gesture(Array.from({ length: 12 }, () => 6));
    expect(directions.filter((d) => d !== 0)).toEqual([1]);
  });

  it('switches at most once per gesture even with a long inertia tail', () => {
    const { directions } = gesture(Array.from({ length: 40 }, () => 40), 6, 16);
    expect(directions.filter((d) => d !== 0)).toEqual([1]);
  });

  it('keeps the direction stable when the gesture wobbles the other way', () => {
    const { directions } = gesture([30, 30, -20, 40, -10, 40]);
    expect(directions.filter((d) => d !== 0)).toEqual([1]);
  });

  it('reports the opposite direction on a gesture that starts after the idle gap', () => {
    const first = wheelStep(TAB_WHEEL_INITIAL, wheel(120), 4, T0);
    expect(first.direction).toBe(1);
    const second = wheelStep(
      first.state,
      wheel(-120),
      4,
      T0 + TAB_WHEEL_GESTURE_IDLE_MS + 40,
    );
    expect(second.direction).toBe(-1);
  });

  it('allows several switches when the user scrolls in separate gestures', () => {
    let state: TabWheelState = { ...TAB_WHEEL_INITIAL };
    const directions: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const at = T0 + i * (TAB_WHEEL_GESTURE_IDLE_MS + 100);
      const result = wheelStep(state, wheel(60), 6, at);
      state = result.state;
      directions.push(result.direction);
    }
    expect(directions).toEqual([1, 1, 1]);
  });

  it('ignores opposite-direction noise before the direction is locked', () => {
    // 第一个事件只有 3px,不足以锁定方向;随后反向事件把它抵掉
    const a = wheelStep(TAB_WHEEL_INITIAL, wheel(3), 4, T0);
    expect(a.direction).toBe(0);
    const b = wheelStep(a.state, wheel(-3), 4, T0 + 16);
    expect(b.direction).toBe(0);
    expect(b.state.accumulated).toBe(0);
  });

  it('locks the direction after the lock threshold and keeps it', () => {
    const a = wheelStep(TAB_WHEEL_INITIAL, wheel(TAB_WHEEL_DIRECTION_LOCK), 4, T0);
    expect(a.state.direction).toBe(1);
    const b = wheelStep(a.state, wheel(-30), 4, T0 + 16);
    expect(b.direction).toBe(0);
    expect(b.state.direction).toBe(1);
  });

  it('needs a fresh gesture to switch again after a completed one', () => {
    const first = wheelStep(TAB_WHEEL_INITIAL, wheel(TAB_WHEEL_STEP), 4, T0);
    expect(first.direction).toBe(1);
    const sameGesture = wheelStep(first.state, wheel(TAB_WHEEL_STEP * 3), 4, T0 + 30);
    expect(sameGesture.direction).toBe(0);
    const nextGesture = wheelStep(sameGesture.state, wheel(TAB_WHEEL_STEP), 4, T0 + 30 + TAB_WHEEL_GESTURE_IDLE_MS + 60);
    expect(nextGesture.direction).toBe(1);
  });

  it('ignores empty or non-finite deltas without switching', () => {
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(0), 4, T0).direction).toBe(0);
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(Number.NaN), 4, T0).direction).toBe(0);
  });
});

describe('cycleTabIndex', () => {
  it('advances and wraps around both ends', () => {
    expect(cycleTabIndex(0, 3, 1)).toBe(1);
    expect(cycleTabIndex(2, 3, 1)).toBe(0);
    expect(cycleTabIndex(0, 3, -1)).toBe(2);
  });

  it('does not cycle with a single tab or an unknown current index', () => {
    expect(cycleTabIndex(0, 1, 1)).toBeNull();
    expect(cycleTabIndex(-1, 4, 1)).toBeNull();
    expect(cycleTabIndex(9, 4, 1)).toBeNull();
  });

  it('matches the Ctrl+Tab order for multiple steps', () => {
    let index = 0;
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      index = cycleTabIndex(index, 3, 1) ?? index;
      seen.push(index);
    }
    expect(seen).toEqual([1, 2, 0, 1, 2]);
  });
});
