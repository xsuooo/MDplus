// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchBar } from '../src/components/SearchBar';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('search keyboard scope', () => {
  function press(key: string, extra: KeyboardEventInit & { defaultPrevented?: boolean } = {}) {
    const close = vi.fn();
    // Use the real React dispatcher so adding a memo/ref hook cannot make this
    // test fail for reasons unrelated to keyboard ownership.
    const view = render(<SearchBar editor={null} onClose={close} />);
    const field = within(view.container).getByRole('textbox', { name: '搜索关键词' });
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    if (extra.keyCode) Object.defineProperty(event, 'keyCode', { value: extra.keyCode });
    if (extra.defaultPrevented) event.preventDefault();
    const preventDefault = vi.spyOn(event, 'preventDefault');
    fireEvent(field, event);
    view.unmount();
    return { close, event, preventDefault };
  }

  it('consumes Escape so the outer outline listener cannot close a second panel', () => {
    const outerClose = vi.fn();
    const outer = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) outerClose();
    };
    window.addEventListener('keydown', outer);
    try {
      const { close, event, preventDefault } = press('Escape');
      expect(close).toHaveBeenCalledOnce();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
      expect(outerClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outer);
    }
  });

  it.each([{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }])(
    'preserves composition and already handled keys: %j',
    (extra) => {
      for (const key of ['Escape', 'Enter']) {
        const { close, preventDefault } = press(key, extra);
        expect(close).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
      }
    },
  );
});
