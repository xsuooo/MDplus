import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/mermaid', () => ({ refreshMermaidTheme: refresh }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(initialTheme?: string) {
  const classes = new Set<string>();
  const root = {
    dataset: { theme: initialTheme },
    classList: {
      add: (value: string) => classes.add(value),
      remove: (value: string) => classes.delete(value),
    },
  };
  const transitions: {
    update: () => Promise<void>;
    skipTransition: ReturnType<typeof vi.fn>;
    finish: () => void;
  }[] = [];
  const document = {
    documentElement: root,
    visibilityState: 'visible',
    startViewTransition: vi.fn((update: () => Promise<void>) => {
      const completion = deferred();
      const transition = {
        update, skipTransition: vi.fn(), finish: completion.resolve,
        finished: completion.promise, ready: Promise.resolve(),
      };
      transitions.push(transition);
      return transition;
    }),
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: false })) });
  return { document, root, transitions, classes };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  refresh.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('coordinated theme transitions', () => {
  it('applies the first theme immediately without an entrance animation', async () => {
    const { root, document } = fixture();
    const { applyTheme } = await import('../src/lib/theme');
    applyTheme('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(refresh).toHaveBeenCalledOnce();
    expect(document.startViewTransition).not.toHaveBeenCalled();
  });

  it('does not animate or rerender when the effective theme is unchanged', async () => {
    const { document } = fixture('light');
    const { applyTheme } = await import('../src/lib/theme');
    applyTheme('light');
    expect(refresh).not.toHaveBeenCalled();
    expect(document.startViewTransition).not.toHaveBeenCalled();
  });

  it('waits for the new diagram scene before capturing it', async () => {
    const { root, transitions, classes } = fixture('light');
    const { applyTheme } = await import('../src/lib/theme');
    const diagram = deferred();
    refresh.mockReturnValue(diagram.promise);
    applyTheme('dark');
    expect(root.dataset.theme).toBe('light');
    expect(classes.has('theme-transitioning')).toBe(true);
    let captured = false;
    const update = transitions[0].update().then(() => { captured = true; });
    expect(root.dataset.theme).toBe('dark');
    await Promise.resolve();
    expect(captured).toBe(false);
    diagram.resolve();
    await update;
    expect(captured).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    transitions[0].finish();
    await Promise.resolve();
    expect(classes.has('theme-transitioning')).toBe(false);
  });

  it('bounds snapshot preparation when a slow diagram does not finish', async () => {
    const { transitions } = fixture('light');
    const { applyTheme } = await import('../src/lib/theme');
    refresh.mockReturnValue(new Promise(() => {}));
    applyTheme('dark');
    const update = transitions[0].update();
    await vi.advanceTimersByTimeAsync(200);
    await expect(update).resolves.toBeUndefined();
  });

  it('keeps the requested theme when a diagram refresh rejects', async () => {
    const { root, transitions } = fixture('light');
    const { applyTheme } = await import('../src/lib/theme');
    refresh.mockRejectedValue(new Error('diagram unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      applyTheme('dark');
      await expect(transitions[0].update()).resolves.toBeUndefined();
      expect(root.dataset.theme).toBe('dark');
      expect(warning).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });

  it('cancels a queued dark update when the last request is light', async () => {
    const { root, transitions, classes } = fixture('light');
    const { applyTheme } = await import('../src/lib/theme');
    applyTheme('dark');
    applyTheme('light');
    await transitions[0].update();
    expect(transitions[0].skipTransition).toHaveBeenCalledOnce();
    expect(root.dataset.theme).toBe('light');
    expect(refresh).not.toHaveBeenCalled();
    expect(classes.has('theme-transitioning')).toBe(false);
  });

  it('does not let an older transition cleanup interrupt a newer transition', async () => {
    const { transitions, classes } = fixture('light');
    const { applyTheme } = await import('../src/lib/theme');
    applyTheme('dark');
    await transitions[0].update();
    applyTheme('light');
    transitions[0].finish();
    await Promise.resolve();
    expect(classes.has('theme-transitioning')).toBe(true);
    await transitions[1].update();
    transitions[1].finish();
    await Promise.resolve();
    expect(classes.has('theme-transitioning')).toBe(false);
  });

  it.each(['reduced-motion', 'hidden', 'unsupported'])('uses the immediate path for %s', async (mode) => {
    const { document, root, transitions } = fixture('light');
    if (mode === 'reduced-motion') vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    if (mode === 'hidden') document.visibilityState = 'hidden';
    if (mode === 'unsupported') Object.assign(document, { startViewTransition: undefined });
    const { applyTheme } = await import('../src/lib/theme');
    applyTheme('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(refresh).toHaveBeenCalledOnce();
    expect(transitions).toHaveLength(0);
  });
});
