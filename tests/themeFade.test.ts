import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_FADE_MS, afterThemeFade, beginThemeFade } from '../src/lib/themeFade';

afterEach(() => {
  vi.useRealTimers();
});

describe('theme fade gate', () => {
  it('mirrors the CSS duration of the surface color transition', () => {
    const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
    const declared = /--motion-theme:\s*(\d+)ms;/.exec(css);
    expect(declared && Number(declared[1])).toBe(THEME_FADE_MS);
  });

  it('holds follow-up work until the fade and one more frame have passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    beginThemeFade();
    const order: string[] = [];
    void afterThemeFade().then(() => order.push('work'));
    await vi.advanceTimersByTimeAsync(THEME_FADE_MS);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(16);
    expect(order).toEqual(['work']);
  });

  it('does not delay work when no fade is in progress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    beginThemeFade();
    await vi.advanceTimersByTimeAsync(THEME_FADE_MS + 1);
    const order: string[] = [];
    void afterThemeFade().then(() => order.push('work'));
    // No timer is involved: a resolved promise settles within the microtask queue.
    await Promise.resolve();
    expect(order).toEqual(['work']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('measures from the latest theme change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    beginThemeFade();
    await vi.advanceTimersByTimeAsync(THEME_FADE_MS - 20);
    beginThemeFade();
    const order: string[] = [];
    void afterThemeFade().then(() => order.push('work'));
    await vi.advanceTimersByTimeAsync(40);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(THEME_FADE_MS);
    expect(order).toEqual(['work']);
  });
});
