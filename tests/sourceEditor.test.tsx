import type { ReactElement } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Run the component's handlers and layout effects without a WebView dependency.
const hooks = vi.hoisted(() => ({
  slots: [] as any[],
  cursor: 0,
  effects: [] as (() => void)[],
  dirty: false,
}));
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return {
    ...react,
    memo: (component: unknown) => component,
    useRef: (initial: unknown) => {
      const slot = hooks.cursor++;
      return hooks.slots[slot] ??= { current: initial };
    },
    useState: (initial: unknown) => {
      const slot = hooks.cursor++;
      const state = hooks.slots[slot] ??= { value: initial };
      return [state.value, (next: unknown) => {
        if (state.value !== next) hooks.dirty = true;
        state.value = next;
      }];
    },
    useLayoutEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
      const slot = hooks.cursor++;
      const previous = hooks.slots[slot];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      const state = { deps, cleanup: undefined as (() => void) | void };
      hooks.slots[slot] = state;
      hooks.effects.push(() => {
        previous?.cleanup?.();
        state.cleanup = effect();
      });
    },
  };
});

import { SourceEditor } from '../src/components/SourceEditor';
import type { PendingImageReference } from '../src/lib/imagePaths';

function mount(initial = 'abc', saveImage = vi.fn(async () => 'image.png')) {
  let value = initial;
  let imageRewrites: PendingImageReference[] | undefined;
  let field: ReactElement<any> & { ref: { current: unknown } };
  const changes = vi.fn();
  const input = {
    value, selectionStart: 0, selectionEnd: 0, isConnected: true,
    focus: vi.fn(), scrollTop: 0, scrollLeft: 0, selectionDirection: 'none',
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
  const render = () => {
    do {
      hooks.dirty = false;
      hooks.cursor = 0;
      const tree = SourceEditor({
        tabId: 'tab', value, onChange: (next) => { value = next; changes(next); },
        onClose: vi.fn(), onImagePaste: saveImage, imageRewrites,
      }) as ReactElement<{ children: ReactElement[] }>;
      field = tree.props.children.find((child) => child.type === 'textarea')! as typeof field;
      input.value = field.props.value;
      field.ref.current = input;
      hooks.effects.splice(0).forEach((effect) => effect());
    } while (hooks.dirty);
  };
  render();
  return {
    input, changes,
    select(start: number, end = start) {
      input.setSelectionRange(start, end);
      field.props.onSelect();
    },
    change(text: string, caret = text.length, inputType = 'insertText') {
      input.value = text;
      input.setSelectionRange(caret, caret);
      field.props.onChange({ target: input, nativeEvent: { inputType } });
      render();
    },
    key(key: string, extra: Record<string, unknown> = {}) {
      const nativeEvent = { key, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, ...extra };
      const event = { ...nativeEvent, nativeEvent, preventDefault: vi.fn() };
      field.props.onKeyDown(event);
      render();
      return event;
    },
    composition(start: boolean) {
      field.props[start ? 'onCompositionStart' : 'onCompositionEnd']({ currentTarget: input });
      render();
    },
    external(text: string) { value = text; render(); },
    migrate(text: string, references: PendingImageReference[]) { imageRewrites = references; value = text; render(); },
    async paste() {
      field.props.onPaste({
        currentTarget: input, preventDefault: vi.fn(),
        clipboardData: { items: [{ type: 'image/png', getAsFile: () => new File(['image'], 'test.png') }] },
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      render();
    },
    render,
  };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.dirty = false;
  vi.useFakeTimers();
  vi.setSystemTime(10000);
});
afterEach(() => vi.useRealTimers());

describe('SourceEditor history', () => {
  it('coalesces continuous typing using the time of the last edit', () => {
    const editor = mount();
    editor.select(3);
    editor.change('abcd');
    vi.advanceTimersByTime(300);
    editor.change('abcde');
    vi.advanceTimersByTime(300);
    editor.change('abcdef');
    editor.key('z');
    expect(editor.input.value).toBe('abc');
    expect(editor.input.selectionStart).toBe(3);
    editor.key('z', { shiftKey: true });
    expect(editor.input.value).toBe('abcdef');
    expect(editor.input.selectionStart).toBe(6);
  });

  it('breaks a typing group on selection movement and discards redo after an edit', () => {
    const editor = mount();
    editor.select(3);
    editor.change('abcd');
    editor.select(0);
    editor.change('xabcd', 1);
    editor.key('z');
    expect(editor.input.value).toBe('abcd');
    expect(editor.input.selectionStart).toBe(0);
    editor.change('yabcd', 1);
    editor.key('y');
    expect(editor.input.value).toBe('yabcd');
  });

  it.each([{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { defaultPrevented: true }])(
    'does not intercept protected undo: %j', (extra) => {
      const editor = mount();
      editor.change('abcd');
      expect(editor.key('z', extra).preventDefault).not.toHaveBeenCalled();
      expect(editor.input.value).toBe('abcd');
    },
  );

  it('groups a long IME composition into one undo step', () => {
    const editor = mount('');
    editor.composition(true);
    editor.change('n', 1, 'insertCompositionText');
    vi.advanceTimersByTime(1000);
    editor.change('ni', 2, 'insertCompositionText');
    editor.change('\u4f60', 1, 'insertCompositionText');
    editor.composition(false);
    editor.key('z');
    expect(editor.input.value).toBe('');
    editor.key('y');
    expect(editor.input.value).toBe('\u4f60');
  });

  it('includes the committed text when compositionend precedes the last change event', () => {
    const editor = mount('');
    editor.composition(true);
    editor.change('ni', 2, 'insertCompositionText');
    editor.input.value = '\u4f60';
    editor.composition(false);
    editor.change('\u4f60', 1, 'insertText');
    editor.key('z');
    expect(editor.input.value).toBe('');
    editor.key('y');
    expect(editor.input.value).toBe('\u4f60');
  });

  it('does not waste an undo step after cancelling a composition', () => {
    const editor = mount('abc');
    editor.change('abcd');
    editor.composition(true);
    editor.composition(false);
    editor.key('z');
    expect(editor.input.value).toBe('abc');
  });

  it('keeps image paste in the same history and restores its replaced selection', async () => {
    const editor = mount();
    editor.select(3);
    editor.change('abcd');
    editor.select(1, 3);
    await editor.paste();
    expect(editor.input.value).toBe('a![](image.png)d');
    editor.key('z');
    expect(editor.input.value).toBe('abcd');
    expect([editor.input.selectionStart, editor.input.selectionEnd]).toEqual([1, 3]);
    editor.key('z');
    expect(editor.input.value).toBe('abc');
    editor.key('y');
    editor.key('y');
    expect(editor.input.value).toBe('a![](image.png)d');
    expect(editor.input.selectionStart).toBe('a![](image.png)'.length);
  });

  it('rejects an asynchronous image after editing and undoing back to the same text', async () => {
    let resolve!: (url: string) => void;
    const editor = mount('abc', vi.fn(() => new Promise<string>((done) => { resolve = done; })));
    editor.select(3);
    await editor.paste();
    editor.change('abcd');
    editor.key('z');
    resolve('stale.png');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    editor.render();
    expect(editor.input.value).toBe('abc');
  });

  it('clears history for a real external replacement, not a parent echo', () => {
    const editor = mount();
    editor.change('abcd');
    editor.external('disk content');
    editor.key('z');
    expect(editor.input.value).toBe('disk content');
  });

  it('rebases source selections and undo history through image migration', () => {
    const original = '![](mdplus-image:one)\n\n中文 text\n\n![](mdplus-image:two)';
    const editor = mount(original);
    editor.change(original + ' edit');
    const at = editor.input.value.indexOf('中文');
    editor.select(at, at + 2);
    const references = [{ placeholder: 'mdplus-image:one', relativePath: './assets/one.png' },
      { placeholder: 'mdplus-image:two', relativePath: './assets/two.png' }];
    const migrated = (original + ' edit').replace('mdplus-image:one', './assets/one.png').replace('mdplus-image:two', './assets/two.png');
    editor.migrate(migrated, references);
    expect(editor.input.value.slice(editor.input.selectionStart, editor.input.selectionEnd)).toBe('中文');
    editor.key('z');
    expect(editor.input.value).not.toContain('mdplus-image:');
    expect(editor.input.value).not.toContain(' edit');
  });

  it('maps the actual DOM selection even before its selection event was delivered', () => {
    const editor = mount('prefix current suffix');
    editor.input.setSelectionRange(15, 21);
    editor.external('prefix longer current suffix');
    expect(editor.input.value.slice(editor.input.selectionStart, editor.input.selectionEnd)).toBe('suffix');
  });
});
