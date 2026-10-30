import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  memo: (component: unknown) => component,
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
}));
vi.mock('../src/lib/search', () => ({
  runSearch: vi.fn(), stepSearch: vi.fn(), clearSearch: vi.fn(),
  getSearchCount: () => 0, subscribeSearchCount: vi.fn(),
}));

import { SearchBar } from '../src/components/SearchBar';

describe('search keyboard scope', () => {
  function press(key: string, extra = {}) {
    const close = vi.fn();
    const tree = SearchBar({ editor: null, onClose: close }) as ReactElement<{ children: ReactElement[] }>;
    const field = tree.props.children.find((child) => child.type === 'input')! as ReactElement<any>;
    const event = {
      key, defaultPrevented: false, nativeEvent: { key, ...extra },
      preventDefault: vi.fn(), ...extra,
    };
    field.props.onKeyDown(event);
    return { close, event };
  }

  it('consumes Escape so the outer outline listener cannot close a second panel', () => {
    const { close, event } = press('Escape');
    expect(close).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }])(
    'preserves composition and already handled keys: %j', (extra) => {
      for (const key of ['Escape', 'Enter']) {
        const { close, event } = press(key, extra);
        expect(close).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
      }
    },
  );
});
