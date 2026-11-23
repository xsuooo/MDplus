// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSceneMotion } from '../src/hooks/useSceneMotion';

let callbacks: Map<number, FrameRequestCallback>;
let media: EventTarget;
let reduced = false;
let serial = 0;

function Scene() {
  return <div data-testid="scene" ref={useSceneMotion()} />;
}
function pointer(element: HTMLElement, type: string, pointerType = 'mouse') {
  const event = new Event(type);
  Object.assign(event, { clientX: 200, clientY: 40, pointerType });
  fireEvent(element, event);
}
function finishFrames() {
  for (let time = 16; callbacks.size && time <= 2400; time += 16) {
    const batch = [...callbacks.values()];
    callbacks.clear();
    act(() => {
      for (const callback of batch) callback(time);
    });
  }
  expect(callbacks.size).toBe(0);
}
function mountScene() {
  const view = render(<Scene />);
  const scene = view.getByTestId('scene');
  vi.spyOn(scene, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 200));
  return { ...view, scene };
}

beforeEach(() => {
  callbacks = new Map();
  reduced = false;
  serial = 0;
  media = new EventTarget();
  Object.defineProperty(media, 'matches', { get: () => reduced });
  vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      const id = ++serial;
      callbacks.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => callbacks.delete(id)),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('welcome composite motion lifecycle', () => {
  it('does no idle frame work, settles on the pointer, then returns to neutral', () => {
    const { scene } = mountScene();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    pointer(scene, 'pointermove');
    expect(scene.classList.contains('scene-in-motion')).toBe(true);
    finishFrames();
    expect(scene.style.getPropertyValue('--scene-x')).toBe('1.0000');
    expect(scene.classList.contains('scene-in-motion')).toBe(false);
    pointer(scene, 'pointerleave');
    finishFrames();
    expect(scene.style.getPropertyValue('--scene-x')).toBe('0.0000');
    expect(scene.style.getPropertyValue('--scene-y')).toBe('0.0000');
  });

  it('ignores touch and reduced-motion pointers', () => {
    const { scene } = mountScene();
    pointer(scene, 'pointermove', 'touch');
    reduced = true;
    pointer(scene, 'pointermove');
    pointer(scene, 'pointerleave');
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(scene.classList.contains('scene-in-motion')).toBe(false);
  });

  it('cancels live work immediately when reduced motion is enabled', () => {
    const { scene } = mountScene();
    pointer(scene, 'pointermove');
    expect(callbacks.size).toBe(1);
    reduced = true;
    act(() => media.dispatchEvent(new Event('change')));
    expect(callbacks.size).toBe(0);
    expect(scene.style.getPropertyValue('--scene-x')).toBe('0.0000');
    expect(scene.classList.contains('scene-in-motion')).toBe(false);
    reduced = false;
    act(() => media.dispatchEvent(new Event('change')));
    pointer(scene, 'pointermove');
    expect(callbacks.size).toBe(1);
  });

  it('caches pointer geometry until resize or leave invalidates it', () => {
    const { scene } = mountScene();
    const geometry = vi.mocked(scene.getBoundingClientRect);
    pointer(scene, 'pointermove');
    pointer(scene, 'pointermove');
    expect(geometry).toHaveBeenCalledTimes(1);
    fireEvent(window, new Event('resize'));
    pointer(scene, 'pointermove');
    expect(geometry).toHaveBeenCalledTimes(2);
    pointer(scene, 'pointerleave');
    finishFrames();
    pointer(scene, 'pointermove');
    expect(geometry).toHaveBeenCalledTimes(3);
    finishFrames();
  });

  it('ignores hidden documents and cancels motion immediately when hidden', () => {
    const { scene } = mountScene();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    pointer(scene, 'pointermove');
    expect(callbacks.size).toBe(0);
    hidden.mockReturnValue(false);
    pointer(scene, 'pointermove');
    expect(callbacks.size).toBe(1);
    hidden.mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(callbacks.size).toBe(0);
    expect(scene.classList.contains('scene-in-motion')).toBe(false);
    expect(scene.style.getPropertyValue('--scene-x')).toBe('0.0000');
    hidden.mockReturnValue(false);
    pointer(scene, 'pointermove');
    finishFrames();
  });

  it('releases animation and listeners on blur and when leaving the welcome screen', () => {
    const { scene, unmount } = mountScene();
    pointer(scene, 'pointermove');
    fireEvent(window, new Event('blur'));
    expect(callbacks.size).toBe(0);
    pointer(scene, 'pointermove');
    expect(callbacks.size).toBe(1);
    unmount();
    expect(callbacks.size).toBe(0);
    pointer(scene, 'pointermove');
    expect(callbacks.size).toBe(0);
  });
});
