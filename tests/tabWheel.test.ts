import { describe, expect, it } from 'vitest';
import {
  TAB_WHEEL_COOLDOWN_MS,
  TAB_WHEEL_INITIAL,
  TAB_WHEEL_THRESHOLD,
  cycleTabIndex,
  wheelStep,
  type TabWheelState,
} from '../src/lib/tabWheel';

const wheel = (deltaY: number, deltaX = 0) => ({ deltaX, deltaY });
const at = (time: number) => time;

describe('wheelStep', () => {
  it('switches to the next tab when the wheel rolls down past the threshold', () => {
    const result = wheelStep(TAB_WHEEL_INITIAL, wheel(TAB_WHEEL_THRESHOLD), 3, at(1000));
    expect(result.direction).toBe(1);
    expect(result.state.accumulated).toBe(0);
  });

  it('switches to the previous tab when the wheel rolls up', () => {
    const result = wheelStep(TAB_WHEEL_INITIAL, wheel(-TAB_WHEEL_THRESHOLD), 3, at(1000));
    expect(result.direction).toBe(-1);
  });

  it('ignores a single tab or no tabs', () => {
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(500), 1, at(1000)).direction).toBe(0);
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(500), 0, at(1000)).direction).toBe(0);
  });

  it('accumulates high-resolution deltas before switching', () => {
    let state: TabWheelState = { ...TAB_WHEEL_INITIAL };
    const directions: number[] = [];
    for (let i = 0; i < TAB_WHEEL_THRESHOLD / 4 - 1; i += 1) {
      const step = wheelStep(state, wheel(4), 4, at(1000));
      state = step.state;
      directions.push(step.direction);
    }
    expect(directions.every((direction) => direction === 0)).toBe(true);
    const final = wheelStep(state, wheel(4), 4, at(1000));
    expect(final.direction).toBe(1);
  });

  it('lets one gesture move only one tab', () => {
    const first = wheelStep(TAB_WHEEL_INITIAL, wheel(TAB_WHEEL_THRESHOLD), 5, at(1000));
    expect(first.direction).toBe(1);
    // 同一次手势里的后续事件(仍在冷却期)不应再切换
    const second = wheelStep(first.state, wheel(TAB_WHEEL_THRESHOLD * 4), 5, at(1000 + TAB_WHEEL_COOLDOWN_MS - 1));
    expect(second.direction).toBe(0);
    expect(second.state.accumulated).toBe(0);
    // 冷却结束后要重新累计到阈值才会再次切换
    const afterCooldown = wheelStep(second.state, wheel(TAB_WHEEL_THRESHOLD / 2), 5, at(1000 + TAB_WHEEL_COOLDOWN_MS));
    expect(afterCooldown.direction).toBe(0);
    const resumed = wheelStep(afterCooldown.state, wheel(TAB_WHEEL_THRESHOLD), 5, at(1000 + TAB_WHEEL_COOLDOWN_MS * 2));
    expect(resumed.direction).toBe(1);
  });

  it('ignores horizontal scrolling so the tab strip can still scroll sideways', () => {
    const result = wheelStep(TAB_WHEEL_INITIAL, wheel(10, 120), 4, at(1000));
    expect(result.direction).toBe(0);
    expect(result.state).toEqual(TAB_WHEEL_INITIAL);
  });

  it('ignores empty or non-finite deltas', () => {
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(0), 4, at(1000)).direction).toBe(0);
    expect(wheelStep(TAB_WHEEL_INITIAL, wheel(Number.NaN), 4, at(1000)).direction).toBe(0);
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
