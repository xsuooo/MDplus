import { useEffect, useRef } from 'react';
import { sceneSpringSettled, stepSceneSpring, type SceneSpring } from '../lib/sceneSpring';

/** Animate only the welcome illustration's composite layers, never the editor or React state. */
export function useSceneMotion() {
  const scene = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scene.current;
    if (!element) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame: number | null = null;
    let previous = 0;
    let bounds: DOMRect | null = null;
    let target = { x: 0, y: 0 };
    let x: SceneSpring = { position: 0, velocity: 0 };
    let y: SceneSpring = { position: 0, velocity: 0 };

    const paint = () => {
      element.style.setProperty('--scene-x', x.position.toFixed(4));
      element.style.setProperty('--scene-y', y.position.toFixed(4));
    };
    const reset = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      previous = 0;
      target = { x: 0, y: 0 };
      x = { position: 0, velocity: 0 };
      y = { position: 0, velocity: 0 };
      element.classList.remove('scene-in-motion');
      paint();
    };
    const tick = (time: number) => {
      const seconds = previous ? (time - previous) / 1000 : 1 / 60;
      previous = time;
      x = stepSceneSpring(x, target.x, seconds);
      y = stepSceneSpring(y, target.y, seconds);
      paint();
      if (sceneSpringSettled(x, target.x) && sceneSpringSettled(y, target.y)) {
        x = { position: target.x, velocity: 0 };
        y = { position: target.y, velocity: 0 };
        paint();
        element.classList.remove('scene-in-motion');
        frame = null;
        previous = 0;
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    const start = () => {
      if (frame !== null || preference.matches || document.hidden) return;
      element.classList.add('scene-in-motion');
      frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || preference.matches || document.hidden) return;
      bounds ??= element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      target = {
        x: Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2)),
        y: Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2)),
      };
      start();
    };
    const leave = () => {
      target = { x: 0, y: 0 };
      bounds = null;
      start();
    };
    const invalidate = () => {
      bounds = null;
    };
    const changePreference = () => {
      if (preference.matches) reset();
    };
    const visibility = () => {
      if (document.hidden) reset();
    };
    element.addEventListener('pointermove', move, { passive: true });
    element.addEventListener('pointerleave', leave, { passive: true });
    window.addEventListener('resize', invalidate, { passive: true });
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', visibility);
    preference.addEventListener('change', changePreference);
    return () => {
      reset();
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerleave', leave);
      window.removeEventListener('resize', invalidate);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', visibility);
      preference.removeEventListener('change', changePreference);
    };
  }, []);

  return scene;
}
