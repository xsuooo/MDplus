// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorZoom } from '../src/components/EditorZoom';
import { EDITOR_ZOOM_STORAGE_KEY } from '../src/lib/editorZoom';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let storage: Pick<Storage, 'getItem' | 'setItem'>;
beforeEach(() => {
  vi.useFakeTimers();
  const entries = new Map<string, string>();
  storage = {
    getItem: vi.fn((key) => entries.get(key) ?? null),
    setItem: vi.fn((key, value) => {
      entries.set(key, value);
    }),
  };
  vi.stubGlobal('localStorage', storage);
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
});
afterEach(() => {
  cleanup();
  document.querySelectorAll('main').forEach((element) => element.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture() {
  const area = document.createElement('main');
  area.innerHTML =
    '<div class="editor-tab active"><div class="milkdown-container"><div class="milkdown"><p>Visible content</p></div></div></div><div class="source-editor" hidden><textarea class="source-textarea"></textarea></div>';
  document.body.append(area);
  const ref = { current: area };
  const rich = area.querySelector<HTMLElement>('.milkdown')!;
  const source = area.querySelector<HTMLTextAreaElement>('textarea')!;
  const control = render(<EditorZoom area={ref} tabId="a" sourceMode={false} />);
  return { area, ref, rich, source, control };
}
function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}
function wheel(target: HTMLElement, deltaY: number) {
  fireEvent.wheel(target, { ctrlKey: true, deltaY });
}
describe('editor zoom rendering', () => {
  it('coalesces a burst without losing steps and writes the preference after the gesture', () => {
    const { rich, control } = fixture();
    const writes = storage.setItem;
    for (let index = 0; index < 8; index++) wheel(rich, -40);
    expect(frames.size).toBe(1);
    expect(rich.style.zoom).toBe('1');
    expect(writes).not.toHaveBeenCalled();
    flushFrame();
    expect(control.getByRole('button').textContent).toBe('180%');
    expect(rich.style.transform).toBe('scale(1.8)');
    act(() => vi.advanceTimersByTime(120));
    expect(rich.style.zoom).toBe('1.8');
    expect(rich.style.transform).toBe('');
    expect(writes).toHaveBeenCalledExactlyOnceWith(EDITOR_ZOOM_STORAGE_KEY, '180');
  });
  it('keeps the order of direction changes at the boundary and cancels a queued zoom on reset', () => {
    const { rich, control } = fixture();
    for (let index = 0; index < 20; index++) wheel(rich, -1);
    wheel(rich, 1);
    flushFrame();
    expect(control.getByRole('button').textContent).toBe('240%');
    wheel(rich, -1);
    fireEvent.click(control.getByRole('button'));
    expect(frames.size).toBe(0);
    act(() => vi.advanceTimersByTime(500));
    expect(rich.style.zoom).toBe('1');
    expect(rich.style.transform).toBe('');
    expect(control.getByRole('button').textContent).toBe('100%');
  });
  it('settles the retained view and applies the same zoom to a newly active source view', () => {
    const { ref, rich, source, control } = fixture();
    wheel(rich, -1);
    flushFrame();
    source.parentElement!.hidden = false;
    control.rerender(<EditorZoom area={ref} tabId="a" sourceMode={true} />);
    expect(rich.style.transform).toBe('');
    expect(rich.style.zoom).toBe('1.1');
    expect(source.style.zoom).toBe('1.1');
    wheel(source, 1);
    flushFrame();
    act(() => vi.advanceTimersByTime(120));
    expect(source.style.zoom).toBe('1');
    expect(control.getByRole('button').textContent).toBe('100%');
  });
  it('persists the final queued value and removes pending work when the control unmounts', () => {
    const { rich, control } = fixture();
    wheel(rich, -1);
    control.unmount();
    expect(frames.size).toBe(0);
    expect(storage.getItem(EDITOR_ZOOM_STORAGE_KEY)).toBe('110');
    expect(rich.style.zoom).toBe('1.1');
    wheel(rich, -1);
    expect(frames.size).toBe(0);
  });
  it('finishes the preview before typing or ordinary scrolling reads the editor geometry', () => {
    const { rich } = fixture();
    wheel(rich, -1);
    flushFrame();
    fireEvent.keyDown(rich, { key: 'a' });
    expect(rich.style.transform).toBe('');
    expect(rich.style.zoom).toBe('1.1');
    wheel(rich, -1);
    flushFrame();
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 });
    act(() => rich.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(rich.style.transform).toBe('');
    expect(rich.style.zoom).toBe('1.2');
  });
});
