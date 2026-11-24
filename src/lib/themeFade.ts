/**
 * How long surface colors keep animating after a theme change. Mirrors `--motion-theme` in
 * global.css; tests/themeFade.test.ts fails when the two drift apart.
 */
export const THEME_FADE_MS = 100;

let fadeUntil = 0;

/** Call when the resolved theme actually changes. */
export function beginThemeFade(): void {
  fadeUntil = performance.now() + THEME_FADE_MS;
}

/**
 * Resolves once the color feedback of the latest theme change has been painted. Long
 * synchronous follow-up work waits here, so it cannot freeze the fade half-way.
 */
export function afterThemeFade(): Promise<void> {
  const remaining = fadeUntil - performance.now();
  if (remaining <= 0) return Promise.resolve();
  // One more frame after the last transition tick, so its final colors reach the screen.
  return new Promise((resolve) => setTimeout(resolve, remaining + 16));
}
