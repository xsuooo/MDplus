import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/mermaid', () => ({ refreshMermaidTheme: refresh }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(initialTheme?: string) {
  const root = { dataset: { theme: initialTheme } };
  vi.stubGlobal('document', { documentElement: root });
  return root;
}

beforeEach(() => {
  refresh.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nonblocking theme updates', () => {
  it.each(['light', 'dark'] as const)('applies the first %s theme synchronously', async (theme) => {
    const root = fixture();
    const { applyTheme } = await import('../src/lib/theme');
    applyTheme(theme);
    expect(root.dataset.theme).toBe(theme);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(['light', 'dark'] as const)('does not rerender an unchanged %s theme', async (theme) => {
    fixture(theme);
    const { applyTheme } = await import('../src/lib/theme');
    applyTheme(theme);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not wait for slow diagrams before applying another theme', async () => {
    const root = fixture('light');
    const { applyTheme } = await import('../src/lib/theme');
    refresh.mockReturnValue(new Promise(() => {}));
    applyTheme('dark');
    expect(root.dataset.theme).toBe('dark');
    applyTheme('light');
    expect(root.dataset.theme).toBe('light');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps the requested theme and handles a failed diagram refresh', async () => {
    const root = fixture('light');
    const { applyTheme } = await import('../src/lib/theme');
    const error = new Error('diagram unavailable');
    refresh.mockRejectedValue(error);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      applyTheme('dark');
      await Promise.resolve();
      expect(root.dataset.theme).toBe('dark');
      expect(warning).toHaveBeenCalledWith('图表主题刷新失败', error);
    } finally { warning.mockRestore(); }
  });

  it('does not let older diagram completions restore an obsolete theme', async () => {
    const root = fixture('light');
    const { applyTheme } = await import('../src/lib/theme');
    const older = deferred(); const newer = deferred();
    refresh.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    applyTheme('dark'); applyTheme('light');
    newer.resolve(); await newer.promise;
    older.resolve(); await older.promise;
    expect(root.dataset.theme).toBe('light');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('uses the effective DOM theme rather than a stale cached request', async () => {
    const root = fixture('light');
    const { applyTheme } = await import('../src/lib/theme');
    applyTheme('dark');
    root.dataset.theme = 'light';
    applyTheme('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
