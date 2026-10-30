import { isValidElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUTS, type ShortcutBindings } from '../src/lib/shortcuts';

const hooks = vi.hoisted(() => ({
  slots: [] as any[],
  cursor: 0,
  effects: [] as (() => void)[],
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  memo: (component: unknown) => component,
  useRef: (current: unknown) => hooks.slots[hooks.cursor++] ??= { current },
  useState: (initial: unknown) => {
    const state = hooks.slots[hooks.cursor++] ??= { value: initial };
    return [state.value, (next: any) => {
      state.value = typeof next === 'function' ? next(state.value) : next;
    }];
  },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const slot = hooks.cursor++;
    const previous = hooks.slots[slot];
    if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
    const state = { deps, cleanup: undefined as (() => void) | void };
    hooks.slots[slot] = state;
    hooks.effects.push(() => {
      previous?.cleanup?.();
      state.cleanup = effect();
    });
  },
}));
vi.mock('../src/lib/useDialogFocus', () => ({ useDialogFocus: () => ({ current: null }) }));

import { ShortcutModal } from '../src/components/ShortcutModal';

function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: unknown }>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function mount() {
  let bindings = structuredClone(DEFAULT_SHORTCUTS);
  let nodes: ReactElement<any>[];
  const listeners = new Set<(event: any) => void>();
  vi.stubGlobal('window', {
    addEventListener: vi.fn((_type, listener, capture) => {
      expect(capture).toBe(true);
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type, listener, capture) => {
      expect(capture).toBe(true);
      listeners.delete(listener);
    }),
  });
  const change = vi.fn((next: ShortcutBindings) => { bindings = next; });
  const close = vi.fn();
  const render = () => {
    hooks.cursor = 0;
    nodes = elements(ShortcutModal({ bindings, onChange: change, onClose: close }));
    hooks.effects.splice(0).forEach((effect) => effect());
  };
  const button = (name: string) => nodes.find((node) => node.type === 'button' && node.props['aria-label'] === name);
  render();
  return {
    change, close, button,
    bindings: () => bindings,
    listeners: () => listeners.size,
    click(name: string) {
      const target = button(name);
      expect(target, name).toBeDefined();
      target!.props.onClick();
      render();
    },
    press(key: string, extra = {}) {
      const event = {
        key, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false,
        repeat: false, getModifierState: () => false,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra,
      };
      [...listeners].forEach((listener) => listener(event));
      render();
      return event;
    },
  };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.effects = [];
  hooks.cursor = 0;
});
afterEach(() => {
  hooks.slots.forEach((slot) => slot?.cleanup?.());
  vi.unstubAllGlobals();
});

describe('ShortcutModal capture interactions', () => {
  it('clicking a key replaces that key, keeps the other alias, and cleans up its listener', () => {
    const modal = mount();
    modal.click('修改「切换大纲」的 Ctrl+Shift+E');
    expect(modal.button('修改「切换大纲」的 F11')).toBeDefined();
    expect(modal.button('修改「切换大纲」的 Ctrl+Shift+E')?.props['aria-pressed']).toBe(true);
    modal.press('F4');
    expect(modal.bindings().toggleOutline).toEqual(['f4', 'f11']);
    expect(modal.change).toHaveBeenCalledOnce();
    expect(modal.listeners()).toBe(0);
  });

  it('the Add button keeps existing keys visible and appends a new binding', () => {
    const modal = mount();
    modal.click('添加「切换大纲」快捷键');
    expect(modal.button('修改「切换大纲」的 Ctrl+Shift+E')?.props['aria-pressed']).toBe(false);
    expect(modal.button('修改「切换大纲」的 F11')).toBeDefined();
    modal.press('F4');
    expect(modal.bindings().toggleOutline).toEqual(['ctrl+shift+e', 'f11', 'f4']);
  });

  it('a conflict keeps the old key until a valid replacement is recorded', () => {
    const modal = mount();
    modal.click('修改「保存」的 Ctrl+S');
    modal.press('F11');
    expect(modal.change).not.toHaveBeenCalled();
    expect(modal.bindings().save).toEqual(['ctrl+s']);
    expect(modal.button('取消录制「保存」快捷键')).toBeDefined();
    modal.press('q', { ctrlKey: true });
    expect(modal.bindings().save).toEqual(['ctrl+q']);
  });

  it.each(['escape', 'button'])('cancels replacement through %s without changing bindings or closing the modal', (method) => {
    const modal = mount();
    modal.click('修改「切换大纲」的 F11');
    if (method === 'escape') {
      const event = modal.press('Escape');
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    } else {
      modal.click('取消录制「切换大纲」快捷键');
    }
    expect(modal.change).not.toHaveBeenCalled();
    expect(modal.close).not.toHaveBeenCalled();
    expect(modal.bindings()).toEqual(DEFAULT_SHORTCUTS);
    expect(modal.listeners()).toBe(0);
  });

  it('can add a first key to an unbound action', () => {
    const modal = mount();
    modal.click('清除「保存」快捷键');
    modal.click('添加「保存」快捷键');
    modal.press('F4');
    expect(modal.bindings().save).toEqual(['f4']);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }, { getModifierState: () => true }])(
    'does not consume input-method events during replacement: %j', (extra) => {
      const modal = mount();
      modal.click('修改「保存」的 Ctrl+S');
      const event = modal.press('F4', extra);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(modal.change).not.toHaveBeenCalled();
      expect(modal.listeners()).toBe(1);
    },
  );

  it('ignores a held key and a bare letter without losing the replacement target', () => {
    const modal = mount();
    modal.click('修改「切换大纲」的 F11');
    modal.press('F4', { repeat: true });
    modal.press('a');
    expect(modal.change).not.toHaveBeenCalled();
    modal.press('F4');
    expect(modal.bindings().toggleOutline).toEqual(['ctrl+shift+e', 'f4']);
  });
});
