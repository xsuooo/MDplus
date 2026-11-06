// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BodyFont } from '../src/lib/editorFont';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  fonts: vi.fn(),
  dataURL: vi.fn(),
}));
vi.mock('mermaid', () => ({
  default: { initialize: mocks.initialize, render: mocks.render },
}));
vi.mock('../src/lib/fontResources', () => ({
  bodyFamily: (font: string) => `"${font}"`,
  embeddedFonts: mocks.fonts,
  blobDataURL: mocks.dataURL,
}));

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><text>图表</text></svg>';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Render did not reach the expected stage');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function previewRenderer() {
  const { renderDiagramMedia } = await import('../src/lib/diagramRender');
  return (code: string, theme: 'light' | 'dark', font: BodyFont, signal?: AbortSignal) =>
    renderDiagramMedia(code, theme, font, { reuse: true, signal });
}

beforeEach(() => {
  vi.resetModules();
  mocks.initialize.mockReset();
  mocks.render.mockReset().mockResolvedValue({ svg });
  mocks.fonts.mockReset().mockResolvedValue({ css: '@font-face{}', licenses: [] });
  mocks.dataURL.mockReset().mockResolvedValue('data:image/svg+xml;base64,PHN2Zz4=');
  document.body.replaceChildren();
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: vi.fn().mockResolvedValue([]), ready: Promise.resolve() },
  });
  Object.defineProperty(document, 'adoptedStyleSheets', {
    configurable: true,
    writable: true,
    value: [],
  });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('diagram rendering work', () => {
  it('shares concurrent identical renders and returns independent layout values', async () => {
    const renderDiagramMedia = await previewRenderer();
    const [first, second] = await Promise.all([
      renderDiagramMedia('graph TD\nA-->B', 'light', 'misans'),
      renderDiagramMedia('graph TD\nA-->B', 'light', 'misans'),
    ]);
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(mocks.fonts).toHaveBeenCalledOnce();
    expect(mocks.dataURL).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.width = 999;
    const restored = await renderDiagramMedia('graph TD\nA-->B', 'light', 'misans');
    expect(restored.width).toBe(120);
    expect(second.width).toBe(120);
    expect(mocks.render).toHaveBeenCalledOnce();
  });

  it('keeps source, effective theme and body font distinct while reusing loaded fonts', async () => {
    const renderDiagramMedia = await previewRenderer();
    await renderDiagramMedia('graph TD\nA-->B', 'light', 'misans');
    await renderDiagramMedia('graph TD\nA-->B', 'dark', 'misans');
    await renderDiagramMedia('graph TD\nA-->C', 'dark', 'misans');
    await renderDiagramMedia('graph TD\nA-->C', 'dark', 'wenkai');
    expect(mocks.render).toHaveBeenCalledTimes(4);
    expect(mocks.fonts.mock.calls.map(([font]) => font)).toEqual(['misans', 'wenkai']);
    expect(mocks.initialize.mock.calls[0][0]).toMatchObject({
      securityLevel: 'strict',
      theme: 'default',
      suppressErrorRendering: true,
    });
    expect(mocks.initialize.mock.calls[1][0].theme).toBe('dark');
  });

  it('does not cache failures or leave their measurement hosts behind', async () => {
    const renderDiagramMedia = await previewRenderer();
    mocks.render.mockRejectedValueOnce(new Error('Invalid graph'));
    await expect(renderDiagramMedia('invalid', 'light', 'misans')).rejects.toThrow('Invalid graph');
    expect(document.body.childElementCount).toBe(0);
    expect(document.adoptedStyleSheets).toEqual([]);
    await expect(renderDiagramMedia('invalid', 'light', 'misans')).resolves.toMatchObject({
      width: 120,
      height: 80,
    });
    expect(mocks.render).toHaveBeenCalledTimes(2);
  });

  it('retries a failed embedded-font request', async () => {
    const renderDiagramMedia = await previewRenderer();
    mocks.fonts.mockRejectedValueOnce(new Error('Font unavailable'));
    await expect(renderDiagramMedia('graph TD\nA-->B', 'light', 'misans')).rejects.toThrow(
      'Font unavailable',
    );
    await renderDiagramMedia('graph TD\nA-->B', 'light', 'misans');
    expect(mocks.fonts).toHaveBeenCalledTimes(2);
    expect(mocks.render).toHaveBeenCalledOnce();
  });

  it('skips an obsolete queued graph and continues with the latest one', async () => {
    const renderDiagramMedia = await previewRenderer();
    const busy = deferred<{ svg: string }>();
    mocks.render.mockImplementationOnce(() => busy.promise);
    const first = renderDiagramMedia('first', 'light', 'misans');
    await until(() => mocks.render.mock.calls.length === 1);
    const controller = new AbortController();
    const obsolete = renderDiagramMedia('obsolete', 'dark', 'misans', controller.signal).catch(
      (error: unknown) => error,
    );
    const latest = renderDiagramMedia('latest', 'dark', 'misans');
    await until(() => vi.mocked(document.fonts.load).mock.calls.length === 6);
    controller.abort();
    busy.resolve({ svg });
    await Promise.all([first, latest]);
    expect(await obsolete).toMatchObject({ name: 'AbortError' });
    expect(mocks.render.mock.calls.map(([, code]) => code)).toEqual(['first', 'latest']);
  });

  it('keeps shared work alive when only one view cancels it', async () => {
    const renderDiagramMedia = await previewRenderer();
    const busy = deferred<{ svg: string }>();
    mocks.render.mockImplementationOnce(() => busy.promise);
    const controller = new AbortController();
    const cancelled = renderDiagramMedia('shared', 'light', 'misans', controller.signal).catch(
      (error: unknown) => error,
    );
    const active = renderDiagramMedia('shared', 'light', 'misans');
    await until(() => mocks.render.mock.calls.length === 1);
    controller.abort();
    busy.resolve({ svg });
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    await expect(active).resolves.toMatchObject({ width: 120 });
    await renderDiagramMedia('shared', 'light', 'misans');
    expect(mocks.render).toHaveBeenCalledOnce();
  });

  it('bounds cached source revisions instead of retaining every edited graph', async () => {
    const renderDiagramMedia = await previewRenderer();
    for (let index = 0; index < 5; index++)
      await renderDiagramMedia(`graph ${index}`, 'light', 'misans');
    await renderDiagramMedia('graph 4', 'light', 'misans');
    expect(mocks.render).toHaveBeenCalledTimes(5);
    await renderDiagramMedia('graph 0', 'light', 'misans');
    expect(mocks.render).toHaveBeenCalledTimes(6);
  });

  it('yields a visible frame before resource preparation and Mermaid layout', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    const renderDiagramMedia = await previewRenderer();
    const rendered = renderDiagramMedia('graph TD\nA-->B', 'light', 'misans');
    expect(mocks.fonts).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    frames[0](performance.now());
    await until(() => frames.length === 2);
    expect(mocks.initialize).not.toHaveBeenCalled();
    frames[1](performance.now());
    await rendered;
    expect(mocks.initialize).toHaveBeenCalledOnce();
  });

  it('finishes if the page becomes hidden while a paint is pending', async () => {
    let visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const frame = vi.fn().mockReturnValue(1);
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frame);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const renderDiagramMedia = await previewRenderer();
    const pending = renderDiagramMedia('background', 'light', 'misans');
    expect(frame).toHaveBeenCalledOnce();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await pending;
    await renderDiagramMedia('export after hiding', 'light', 'misans');
    expect(cancel).toHaveBeenCalledWith(1);
    expect(mocks.render).toHaveBeenCalledTimes(2);
  });

  it('uses fresh SVG identities for ordinary inline exports', async () => {
    const { renderDiagramMedia } = await import('../src/lib/diagramRender');
    await Promise.all([
      renderDiagramMedia('graph TD\nA-->B', 'light', 'misans'),
      renderDiagramMedia('graph TD\nA-->B', 'light', 'misans'),
    ]);
    expect(mocks.render).toHaveBeenCalledTimes(2);
    expect(mocks.render.mock.calls[0][0]).not.toBe(mocks.render.mock.calls[1][0]);
  });

  it('drops cancelled queue entries without making the latest wait extra frames', async () => {
    let visibility = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const renderDiagramMedia = await previewRenderer();
    const busy = deferred<{ svg: string }>();
    mocks.render.mockImplementationOnce(() => busy.promise);
    const first = renderDiagramMedia('busy', 'light', 'misans');
    await until(() => mocks.render.mock.calls.length === 1);
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const obsolete = controllers.map((controller, index) =>
      renderDiagramMedia(`obsolete ${index}`, 'dark', 'misans', controller.signal).catch(
        (error: unknown) => error,
      ),
    );
    const latest = renderDiagramMedia('latest', 'dark', 'misans');
    await until(() => vi.mocked(document.fonts.load).mock.calls.length === 10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controllers.forEach((controller) => controller.abort());
    visibility = 'visible';
    busy.resolve({ svg });
    await until(() => frames.length > 0);
    frames[0](performance.now());
    await Promise.all([first, latest]);
    expect(frames).toHaveLength(1);
    for (const result of await Promise.all(obsolete))
      expect(result).toMatchObject({ name: 'AbortError' });
    expect(mocks.render.mock.calls.map(([, code]) => code)).toEqual(['busy', 'latest']);
  });
});
