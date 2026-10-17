import { describe, expect, it, vi } from 'vitest';
import { bindEditorZoomControls, EDITOR_ZOOM_STORAGE_KEY, editorZoomKeyAction, isEditorZoomTarget, nextEditorZoom, normalizeEditorZoom, readEditorZoom, writeEditorZoom } from '../src/lib/editorZoom';

function fixture() {
  const view = new EventTarget();
  const doc = { defaultView: view, activeElement: null as unknown };
  const root = new EventTarget() as EventTarget & { ownerDocument: unknown; contains: (target: unknown) => boolean };
  root.ownerDocument = doc;
  const content = { nodeType: 1, closest: vi.fn(() => content) };
  const outside = { nodeType: 1, closest: vi.fn(() => null) };
  root.contains = (target) => target === content || target === outside;
  doc.activeElement = content;
  const actions = vi.fn();
  const listen = vi.spyOn(root, 'addEventListener');
  const cleanup = bindEditorZoomControls(root as unknown as HTMLElement, actions);
  return { root, view, doc, content, outside, actions, listen, cleanup };
}

function keyEvent(key: string, props: Record<string, unknown> = {}) {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key, ctrlKey: true, metaKey: false, altKey: false, ...props });
  return event;
}

function wheelEvent(target: unknown, deltaY: number, props: Record<string, unknown> = {}) {
  const event = new Event('wheel', { cancelable: true });
  Object.assign(event, { deltaY, ctrlKey: true, metaKey: false, altKey: false, ...props });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('editor zoom values', () => {
  it('steps, clamps and resets at both boundaries', () => {
    expect(nextEditorZoom(100, 'increase')).toBe(110);
    expect(nextEditorZoom(100, 'decrease')).toBe(90);
    expect(nextEditorZoom(250, 'increase')).toBe(250);
    expect(nextEditorZoom(50, 'decrease')).toBe(50);
    expect(nextEditorZoom(250, 'reset')).toBe(100);
    expect(nextEditorZoom(50, 'reset')).toBe(100);
    expect(normalizeEditorZoom(116)).toBe(120);
    expect(normalizeEditorZoom(NaN)).toBe(100);
  });

  it.each([null, '', ' ', 'broken', 'Infinity', 'NaN'])('restores invalid or missing value %s as 100', (saved) => {
    expect(readEditorZoom({ getItem: () => saved })).toBe(100);
  });

  it.each([['10', 50], ['300', 250], ['120', 120], ['116', 120]])('restores and normalizes %s', (saved, expected) => {
    expect(readEditorZoom({ getItem: () => saved as string })).toBe(expected);
  });

  it('uses the preference key, persists normalized values and tolerates storage failures', () => {
    const getItem = vi.fn(() => '140');
    expect(readEditorZoom({ getItem })).toBe(140);
    expect(getItem).toHaveBeenCalledWith(EDITOR_ZOOM_STORAGE_KEY);
    const setItem = vi.fn();
    writeEditorZoom(136, { setItem });
    expect(setItem).toHaveBeenCalledWith(EDITOR_ZOOM_STORAGE_KEY, '140');
    expect(readEditorZoom({ getItem: () => { throw new Error('denied'); } })).toBe(100);
    expect(() => writeEditorZoom(120, { setItem: () => { throw new Error('quota'); } })).not.toThrow();
    expect(readEditorZoom()).toBe(100);
    expect(() => writeEditorZoom(120)).not.toThrow();
  });
});

describe('editor zoom controls', () => {
  it.each([['=', 'increase'], ['+', 'increase'], ['-', 'decrease'], ['−', 'decrease'], ['0', 'reset']])('handles Ctrl%s only while content has focus', (key, action) => {
    const { view, doc, outside, actions, cleanup } = fixture();
    const event = keyEvent(key);
    view.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(actions).toHaveBeenCalledWith(action);
    doc.activeElement = outside;
    const outsideEvent = keyEvent(key);
    view.dispatchEvent(outsideEvent);
    expect(outsideEvent.defaultPrevented).toBe(false);
    expect(actions).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('leaves ordinary, alt, meta, unrecognized and already handled keys alone', () => {
    const { view, actions, cleanup } = fixture();
    for (const event of [keyEvent('=', { ctrlKey: false }), keyEvent('+', { altKey: true }), keyEvent('-', { metaKey: true }), keyEvent('a')]) {
      view.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    const handled = keyEvent('=');
    handled.preventDefault();
    view.dispatchEvent(handled);
    expect(actions).not.toHaveBeenCalled();
    expect(editorZoomKeyAction({ key: '=', ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
    cleanup();
  });

  it('uses a non-passive wheel listener, cancels Ctrlwheel and follows delta direction', () => {
    const { root, content, actions, listen, cleanup } = fixture();
    expect(listen).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false, capture: true });
    for (const [delta, action] of [[-1, 'increase'], [240, 'decrease']] as const) {
      const event = wheelEvent(content, delta);
      root.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(actions).toHaveBeenLastCalledWith(action);
    }
    cleanup();
  });

  it('does not cancel ordinary, zero-delta, invalid, modified or out-of-content wheel events', () => {
    const { root, content, outside, actions, cleanup } = fixture();
    for (const event of [wheelEvent(content, 40, { ctrlKey: false }), wheelEvent(content, 0), wheelEvent(content, NaN), wheelEvent(content, 40, { altKey: true }), wheelEvent(content, 40, { metaKey: true }), wheelEvent(outside, 40)]) {
      root.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(actions).not.toHaveBeenCalled();
    cleanup();
  });

  it('limits scope to active rich content or source textarea, including content text nodes', () => {
    const { root, content, outside, cleanup } = fixture();
    expect(isEditorZoomTarget(root as unknown as HTMLElement, content as unknown as EventTarget)).toBe(true);
    expect(content.closest).toHaveBeenCalledWith('.editor-tab.active .milkdown-container, .source-textarea');
    expect(isEditorZoomTarget(root as unknown as HTMLElement, { nodeType: 3, parentElement: content } as unknown as EventTarget)).toBe(true);
    expect(isEditorZoomTarget(root as unknown as HTMLElement, outside as unknown as EventTarget)).toBe(false);
    expect(isEditorZoomTarget(root as unknown as HTMLElement, { nodeType: 1, closest: () => content } as unknown as EventTarget)).toBe(false);
    expect(isEditorZoomTarget(root as unknown as HTMLElement, null)).toBe(false);
    cleanup();
  });

  it('preempts later shortcut listeners and removes both handlers on cleanup', () => {
    const { root, view, content, actions, cleanup } = fixture();
    const later = vi.fn();
    view.addEventListener('keydown', later);
    view.dispatchEvent(keyEvent('='));
    expect(later).not.toHaveBeenCalled();
    cleanup();
    const key = keyEvent('=');
    view.dispatchEvent(key);
    const wheel = wheelEvent(content, -1);
    root.dispatchEvent(wheel);
    expect(key.defaultPrevented).toBe(false);
    expect(wheel.defaultPrevented).toBe(false);
    expect(actions).toHaveBeenCalledTimes(1);
  });
});
