import { describe, expect, it } from 'vitest';
import { sceneSpringSettled, stepSceneSpring, type SceneSpring } from '../src/lib/sceneSpring';

describe('welcome camera spring', () => {
  it('approaches the pointer smoothly and settles without overshoot', () => {
    let state: SceneSpring = { position: 0, velocity: 0 };
    for (let frame = 0; frame < 120; frame++) {
      const next = stepSceneSpring(state, 1, 1 / 60);
      expect(next.position).toBeGreaterThanOrEqual(state.position);
      expect(next.position).toBeLessThanOrEqual(1);
      state = next;
    }
    expect(sceneSpringSettled(state, 1)).toBe(true);
  });

  it('returns to neutral after leaving and is stable after a paused frame', () => {
    let state: SceneSpring = { position: -1, velocity: 0 };
    state = stepSceneSpring(state, 0, 3);
    expect(state.position).toBeCloseTo(-5 / 6);
    for (let frame = 0; frame < 160; frame++) state = stepSceneSpring(state, 0, 1 / 60);
    expect(sceneSpringSettled(state, 0)).toBe(true);
  });

  it('bounds the camera target and never advances a negative timestep', () => {
    const initial = { position: 0, velocity: 0 };
    expect(stepSceneSpring(initial, 10, 1 / 60)).toEqual(stepSceneSpring(initial, 1, 1 / 60));
    expect(stepSceneSpring(initial, -10, 1 / 60)).toEqual(stepSceneSpring(initial, -1, 1 / 60));
    expect(stepSceneSpring(initial, 1, -1)).toEqual(initial);
    expect(sceneSpringSettled({ position: 0.5, velocity: 0 }, 1)).toBe(false);
    expect(sceneSpringSettled({ position: 1, velocity: 0.5 }, 1)).toBe(false);
  });
});
