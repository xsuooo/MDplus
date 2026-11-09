import { editorViewCtx, parserCtx, serializerCtx, type Editor } from '@milkdown/kit/core';
import { closeHistory, redoDepth, undoDepth } from '@milkdown/prose/history';
import { TextSelection, type EditorState } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { createEditor, getCurrentState, redo, undo } from '../../src/lib/editor';
import { flushEditorUpdate } from '../../src/lib/editorUpdates';
import type { EditorUpdate } from '../../src/lib/types';
import { createNativeMocks } from '../browser/nativeMocks';
import '../../src/styles/global.css';
import 'katex/dist/katex.min.css';

const fixtureNames = ['table-1200', 'long-5000', 'images-20'] as const;
type FixtureName = (typeof fixtureNames)[number];
interface InputSample {
  beforeInputAt: number;
  inputAt: number;
  frameAt: number;
  durationMs: number;
  inputEventToFrameMs: number;
  data: string;
  trusted: boolean;
}
interface TimeRange {
  start: number;
  end: number;
}
interface Run {
  name: FixtureName;
  editor: Editor;
  view: EditorView;
  originalState: EditorState;
  opened: TimeRange;
  editorCreateMs: number;
  utf8Bytes: number;
  physicalLines: number;
  inputPosition: number;
  inputStart: number;
  phases: Record<string, number>;
  samples: InputSample[];
  stage: 'ready' | 'input' | 'finished';
  error?: string;
  stopInput?: () => void;
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Performance fixture: ${message}`);
}
const host = document.getElementById('perf-root')!;
const status = document.getElementById('perf-status')!;
const frame = () =>
  new Promise<number>((resolve, reject) => {
    const request = requestAnimationFrame((timestamp) => {
      clearTimeout(timer);
      resolve(timestamp);
    });
    const timer = setTimeout(() => {
      cancelAnimationFrame(request);
      reject(new Error('Performance fixture: animation frame did not arrive within 30000 ms'));
    }, 30000);
  });

function checkEnvironment(view?: EditorView) {
  check(document.visibilityState === 'visible', 'measurement page must be visible');
  check(
    innerWidth === 1200 && innerHeight === 800 && devicePixelRatio === 1,
    `expected viewport 1200x800 at DPR 1, received ${innerWidth}x${innerHeight} at DPR ${devicePixelRatio}`,
  );
  if (view) check(document.hasFocus() && view.hasFocus(), 'editor must hold input focus');
}

const native = createNativeMocks();
native.install();
let run: Run | undefined;
let opened = false;
let latest: EditorUpdate | undefined;
let updates = 0;
const longTasks: { startTime: number; durationMs: number }[] = [];
const longTaskSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
const observer = longTaskSupported
  ? new PerformanceObserver((list) => recordLongTasks(list.getEntries()))
  : undefined;
function recordLongTasks(entries: PerformanceEntry[]) {
  for (const entry of entries)
    longTasks.push({ startTime: entry.startTime, durationMs: entry.duration });
}
observer?.observe({ type: 'longtask', buffered: true });

function imageSource(src: string): string {
  const url = new URL(src, new URL('/tests/perf/fixtures/', location.href));
  check(
    url.origin === location.origin &&
      /^\/tests\/perf\/fixtures\/images\/image-(?:0[1-9]|1[0-9]|20)\.png$/.test(url.pathname),
    `unexpected image source ${src}`,
  );
  return url.href;
}

function validateStructure(current: Run) {
  current.view.state.doc.check();
  if (current.name === 'table-1200') {
    check(host.querySelectorAll('table').length === 1, 'expected one table');
    check(host.querySelectorAll('tbody tr').length === 1201, 'table lost rows');
    for (const row of host.querySelectorAll('tbody tr'))
      check(row.querySelectorAll('th, td').length === 5, 'table lost cells');
  }
  const images = [...host.querySelectorAll<HTMLImageElement>('.md-image-node > img')];
  check(images.length === (current.name === 'images-20' ? 20 : 0), 'unexpected image count');
  for (const image of images)
    check(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0, 'image not decoded');
}

function documentMetrics() {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const content = host.querySelector('.ProseMirror');
  check(content, 'editor DOM is missing');
  const style = getComputedStyle(content);
  return {
    domNodes: document.querySelectorAll('*').length,
    editorDomNodes: host.querySelectorAll('*').length,
    usedJSHeapSizeFallback: memory?.usedJSHeapSize ?? null,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
    editorViewport: { width: host.clientWidth, height: host.clientHeight },
    fonts: {
      body: style.fontFamily,
      bodySize: style.fontSize,
      bodyLineHeight: style.lineHeight,
      code: 'MDPlus JetBrains Mono + MDPlus Sarasa Gothic SC',
    },
    visibility: document.visibilityState,
  };
}

async function open(name: FixtureName) {
  check(!opened, 'open one fixture per fresh page');
  check(fixtureNames.includes(name), `unknown fixture ${name}`);
  checkEnvironment();
  opened = true;
  status.textContent = `Opening ${name}`;
  const start = performance.now();
  const response = await fetch(`/tests/perf/fixtures/${name}.md`, { cache: 'no-store' });
  check(response.ok, `fixture request failed: ${response.status}`);
  const markdown = await response.text();
  const fetchMs = performance.now() - start;
  check(markdown.includes('PERF_INPUT_TARGET'), 'missing input target');
  const physicalLines = markdown.split('\n').length - Number(markdown.endsWith('\n'));
  if (name === 'long-5000') check(physicalLines === 5000, 'long fixture must have 5000 lines');
  const factoryStart = performance.now();
  const editor = createEditor(host, markdown, {
    deferUpdates: true,
    onActivity: () => {},
    onUpdate: (update) => {
      latest = update;
      updates++;
    },
    resolveImageSource: imageSource,
    resolveImageIdentity: (src) => src,
    resolveImageReference: (src) => src,
  });
  const factoryMs = performance.now() - factoryStart;
  let parseMs = 0;
  editor.config((ctx) => {
    const parser = ctx.get(parserCtx);
    ctx.set(parserCtx, (text) => {
      const started = performance.now();
      const parsed = parser(text);
      parseMs += performance.now() - started;
      return parsed;
    });
  });
  const createStart = performance.now();
  await editor.create();
  const editorCreateMs = performance.now() - createStart;
  const stateStart = performance.now();
  latest = getCurrentState(editor, markdown);
  const stateMs = performance.now() - stateStart;
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const fontStart = performance.now();
  await Promise.all([
    ...[
      ['400 16px "MDPlus MiSans"', '中文 Mixed'],
      ['600 16px "MDPlus MiSans"', '中文 Bold'],
      ['400 14px "MDPlus JetBrains Mono"', 'const value = 1;'],
      ['400 14px "MDPlus Sarasa Gothic SC"', '中文代码'],
    ].map(async ([font, text]) => {
      const faces = await document.fonts.load(font, text);
      check(
        faces.length > 0 && faces.every((face) => face.status === 'loaded'),
        `font failed: ${font}`,
      );
    }),
    ...[...host.querySelectorAll<HTMLImageElement>('.md-image-node > img')].map((image) =>
      image.decode(),
    ),
  ]);
  await document.fonts.ready;
  const fontMs = performance.now() - fontStart;
  const frameStart = performance.now();
  await frame();
  await frame();
  const frameMs = performance.now() - frameStart;
  checkEnvironment();
  run = {
    name,
    editor,
    view,
    originalState: view.state,
    opened: { start, end: performance.now() },
    editorCreateMs,
    utf8Bytes: new TextEncoder().encode(markdown).length,
    physicalLines,
    phases: {
      fetchMs,
      factoryMs,
      parseMs,
      createMs: editorCreateMs,
      stateMs,
      fontMs,
      frameMs,
    },
    inputPosition: -1,
    inputStart: 0,
    samples: [],
    stage: 'ready',
  };
  check(undoDepth(view.state) === 0, 'fresh fixture unexpectedly has undo history');
  validateStructure(run);
  status.textContent = `${name} ready`;
  return {
    fixture: name,
    initialOpenMs: run.opened.end - start,
    editorCreateMs,
    utf8Bytes: run.utf8Bytes,
    physicalLines,
    ...documentMetrics(),
  };
}

async function prepareInput() {
  check(run?.stage === 'ready', 'open fixture before preparing input');
  checkEnvironment();
  const current = run;
  let position: number | undefined;
  current.view.state.doc.descendants((node, at) => {
    if (node.isText && node.text?.includes('PERF_INPUT_TARGET')) {
      check(position === undefined, 'input target must be unique');
      position = at + node.text.indexOf('PERF_INPUT_TARGET') + 'PERF_INPUT_TARGET'.length;
    }
  });
  check(position !== undefined, 'parsed document lost input target');
  current.inputPosition = position;
  current.view.dispatch(
    closeHistory(
      current.view.state.tr.setSelection(TextSelection.create(current.view.state.doc, position)),
    ).scrollIntoView(),
  );
  current.view.focus();
  await frame();
  await frame();
  checkEnvironment(current.view);
  let pending: { beforeInputAt: number; data: string; trusted: boolean } | undefined;
  const beforeInput = (event: Event) => {
    if (!(event instanceof InputEvent) || event.inputType !== 'insertText' || !event.data) {
      current.error = 'runner must type ordinary text through browser keyboard input';
      return;
    }
    if (pending) {
      current.error = 'wait for each input frame before typing the next character';
      return;
    }
    pending = { beforeInputAt: performance.now(), data: event.data, trusted: event.isTrusted };
  };
  const input = (event: Event) => {
    const sample = pending;
    if (!sample || !(event instanceof InputEvent) || event.data !== sample.data) {
      current.error = 'input event did not match beforeinput';
      return;
    }
    const inputAt = performance.now();
    requestAnimationFrame(() => {
      const frameAt = performance.now();
      current.samples.push({
        ...sample,
        inputAt,
        frameAt,
        durationMs: frameAt - sample.beforeInputAt,
        inputEventToFrameMs: frameAt - inputAt,
        trusted: sample.trusted && event.isTrusted,
      });
      pending = undefined;
    });
  };
  // Capture before ProseMirror's handlers; the next frame includes DOM mutation processing.
  current.view.dom.addEventListener('beforeinput', beforeInput, true);
  current.view.dom.addEventListener('input', input, true);
  current.stopInput = () => {
    current.view.dom.removeEventListener('beforeinput', beforeInput, true);
    current.view.dom.removeEventListener('input', input, true);
  };
  current.stage = 'input';
  current.inputStart = performance.now();
  return { minimumSamples: 20, input: 'trusted browser keyboard input, one character per sample' };
}

async function waitForInput(count: number) {
  check(run?.stage === 'input', 'input sampling has not started');
  check(Number.isInteger(count) && count > 0, 'sample count must be a positive integer');
  const current = run;
  const deadline = performance.now() + 30000;
  while (current.samples.length < count) {
    check(!current.error, current.error ?? 'input sampling failed');
    check(performance.now() < deadline, `timed out waiting for input ${count}`);
    await frame();
  }
  check(!current.error, current.error ?? 'input sampling failed');
  return current.samples.length;
}

async function finish() {
  check(run?.stage === 'input', 'fixture is not recording input');
  const current = run;
  checkEnvironment(current.view);
  check(!current.error, current.error ?? 'input sampling failed');
  check(current.samples.length >= 20, 'at least 20 keyboard samples are required');
  check(
    current.samples.every((sample) => sample.trusted),
    'untrusted synthetic input was used',
  );
  current.stopInput?.();
  current.stage = 'finished';
  flushEditorUpdate(current.editor);
  const editedDoc = current.view.state.doc;
  const updatesBeforeScroll = updates;
  host.scrollTop = 0;
  let previousFrame = await frame();
  const scrollRange = { start: performance.now(), end: 0 };
  const maximum = host.scrollHeight - host.clientHeight;
  check(maximum > host.clientHeight, 'fixture must overflow its viewport');
  const scrollFrameMs: number[] = [];
  for (let index = 1; index <= 24; index++) {
    host.scrollTop = (maximum * index) / 24;
    const nextFrame = await frame();
    scrollFrameMs.push(nextFrame - previousFrame);
    previousFrame = nextFrame;
  }
  scrollRange.end = performance.now();
  checkEnvironment(current.view);
  check(host.scrollTop > maximum - 2, 'scroll did not reach document end');
  check(current.view.state.doc === editedDoc, 'scroll changed document content');
  check(updates === updatesBeforeScroll, 'scroll republished document content');
  await frame();
  recordLongTasks(observer?.takeRecords() ?? []);
  observer?.disconnect();
  const ranges = {
    open: current.opened,
    input: { start: current.inputStart, end: current.samples[current.samples.length - 1].frameAt },
    scroll: scrollRange,
  };
  const measuredLongTasks = longTasks.flatMap((task) => {
    const phase = Object.entries(ranges).find(
      ([, range]) => task.startTime >= range.start && task.startTime < range.end,
    )?.[0];
    return phase ? [{ ...task, phase }] : [];
  });
  const metrics = documentMetrics();
  const inserted = current.samples.map((sample) => sample.data).join('');
  const expected = current.originalState.tr.insertText(inserted, current.inputPosition).doc;
  check(editedDoc.eq(expected), 'keyboard input changed unexpected document content');
  check(latest, 'content mirror is missing');
  const mirrorMarkdown = latest.markdown;
  // Markdown omits generated heading IDs; verify the exact mirror and round-trip text separately.
  check(
    mirrorMarkdown === current.editor.action((ctx) => ctx.get(serializerCtx)(editedDoc)),
    'content mirror did not serialize the current document',
  );
  const mirrored = current.editor.action((ctx) => ctx.get(parserCtx)(mirrorMarkdown));
  check(
    mirrored?.textContent === editedDoc.textContent,
    'content mirror did not preserve complete round-trip text',
  );
  validateStructure(current);
  const historySteps = undoDepth(current.view.state);
  check(historySteps > 0, 'keyboard input lost undo history');
  // Assertions run after metric collection so full-document comparisons do not pollute timings.
  for (let index = 0; index < historySteps; index++) undo(current.editor);
  check(current.view.state.doc.eq(current.originalState.doc), 'undo did not restore the document');
  check(
    getCurrentState(current.editor).markdown ===
      current.editor.action((ctx) => ctx.get(serializerCtx)(current.originalState.doc)),
    'undo changed Markdown',
  );
  check(redoDepth(current.view.state) === historySteps, 'undo lost redo history');
  for (let index = 0; index < historySteps; index++) redo(current.editor);
  check(current.view.state.doc.eq(editedDoc), 'redo did not restore all keyboard input');
  validateStructure(current);
  status.textContent = `${current.name} passed`;
  return {
    fixture: current.name,
    phases: current.phases,
    initialOpenMs: current.opened.end - current.opened.start,
    editorCreateMs: current.editorCreateMs,
    utf8Bytes: current.utf8Bytes,
    physicalLines: current.physicalLines,
    inputSampleMethod: 'trusted browser beforeinput capture to next requestAnimationFrame',
    inputSamples: current.samples,
    inputToFrameMs: current.samples.map((sample) => sample.durationMs),
    scrollFrameMs,
    longTaskSupported,
    longTaskCount: measuredLongTasks.length,
    longTaskDurationMs: measuredLongTasks.map((task) => task.durationMs),
    longTasks: measuredLongTasks,
    ranges,
    ...metrics,
    assertions: { content: true, undo: true, redo: true, structure: true, historySteps },
    nativeScope: 'mocked; no Rust file I/O, App recovery/autosave, OS input, or hardware IME',
    nativeCalls: native.calls.length,
  };
}

const perfHarness = { open, prepareInput, waitForInput, finish };
declare global {
  interface Window {
    perfReady: boolean;
    perfHarness: typeof perfHarness;
  }
}
window.perfHarness = perfHarness;
window.perfReady = true;
status.textContent = 'Performance fixture ready';
