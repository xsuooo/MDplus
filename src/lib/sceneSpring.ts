export interface SceneSpring {
  position: number;
  velocity: number;
}

/** A critically damped, bounded camera spring; time is in seconds. */
export function stepSceneSpring(state: SceneSpring, target: number, seconds: number): SceneSpring {
  const dt = Math.max(0, Math.min(seconds, 1 / 30));
  const goal = Math.max(-1, Math.min(target, 1));
  const acceleration = (goal - state.position) * 150 - state.velocity * 25;
  const velocity = state.velocity + acceleration * dt;
  return { position: state.position + velocity * dt, velocity };
}

export function sceneSpringSettled(state: SceneSpring, target: number): boolean {
  return Math.abs(state.position - target) < 0.001 && Math.abs(state.velocity) < 0.006;
}
