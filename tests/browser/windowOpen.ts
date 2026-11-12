import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { createNativeMocks } from './nativeMocks';

export const windowOpenCases = [
  'window-open-delayed-recents',
  'window-open-delayed-preferences',
  'window-open-delayed-file',
  'window-open-error-after-show',
] as const;
export type WindowOpenCase = (typeof windowOpenCases)[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => unknown, label: string, observe?: () => void) {
  const deadline = performance.now() + 15000;
  while (!condition()) {
    check(performance.now() < deadline, `Window opening timed out: ${label}`);
    await frame();
    observe?.();
  }
}
type Rect = [number, number, number, number];
function rect(selector: string): Rect | null {
  const element = document.querySelector(selector);
  if (!element) return null;
  const { left, top, width, height } = element.getBoundingClientRect();
  return [left, top, width, height];
}
function difference(before: Rect, after: Rect) {
  return Math.max(...before.map((value, index) => Math.abs(value - after[index])));
}

/** Real App layout; only native files, settings and window commands stay in memory. */
export async function runWindowOpenRegression(testCase: WindowOpenCase): Promise<string> {
  const delayedRecents = testCase === 'window-open-delayed-recents';
  const delayedPreferences = testCase === 'window-open-delayed-preferences';
  const delayedFile = testCase === 'window-open-delayed-file';
  const failedFile = testCase === 'window-open-error-after-show';
  const filePath = 'C:/window-open-fixture/document.md';
  const markdown =
    '# First document 中文 Mixed\n\n```ts\nconst ready = "中文";\n```\n\n' +
    Array.from(
      { length: 16 },
      (_, index) =>
        `## Section ${index}\n\n${'首次打开的正文位置保持稳定。 Mixed text 0123456789. '.repeat(10)}\n`,
    ).join('\n');
  const recentFiles = Array.from({ length: 5 }, (_, index) => ({
    path: `C:/window-open-fixture/recent-${index}.md`,
    name: `最近文稿 ${index}.md`,
    time: Date.now() - index,
  }));
  const settings = new Map<string, unknown>([
    ['theme-mode', delayedPreferences || delayedFile ? 'dark' : 'light'],
    ['outline-open', delayedPreferences],
    ['source-mode', false],
    ['recent-files', failedFile ? [{ path: filePath, name: '失效文稿.md', time: 1 }] : recentFiles],
    ['window-state', { width: 1080, height: 740, x: 180, y: 100, maximized: true }],
  ]);
  localStorage.setItem('mdplus-body-font', delayedFile ? 'wenkai' : 'misans');
  localStorage.setItem('mdplus-editor-font', delayedFile ? 'cascadia-misans' : 'jetbrains-sarasa');
  localStorage.setItem('mdplus-outline-width', '248');
  const settingsGate = deferred();
  const fileGate = deferred();
  let settingsReadStarted = false;
  let startupFilesTaken = false;
  let fileReadStarted = false;
  let fileReadFinished = false;
  const began = performance.now();
  const capture = () => {
    const welcome = document.querySelector<HTMLElement>('.welcome');
    const source = document.querySelector<HTMLTextAreaElement>(
      '.source-editor:not([hidden]) .source-textarea',
    );
    const scroller = document.querySelector<HTMLElement>('.editor-tab.active .milkdown-container');
    const bodyFamily = delayedFile ? '"MDPlus LXGW WenKai"' : '"MDPlus MiSans"';
    const codeFamilies = delayedFile
      ? ['"MDPlus Cascadia Code"', '"MDPlus MiSans"']
      : ['"MDPlus JetBrains Mono"', '"MDPlus Sarasa Gothic SC"'];
    return {
      at: performance.now() - began,
      theme: document.documentElement.dataset.theme,
      welcome: rect('.welcome'),
      logo: rect('.welcome-logo'),
      welcomeHeading: rect('.welcome h1'),
      recentNames: Array.from(document.querySelectorAll('.welcome-recent-item')).map(
        (item) => item.firstElementChild?.textContent,
      ),
      recentDirectories: Array.from(document.querySelectorAll('.welcome-recent-path')).map(
        (item) => item.textContent,
      ),
      welcomeOpacity: welcome ? Number(getComputedStyle(welcome).opacity) : null,
      welcomeTransform: welcome ? getComputedStyle(welcome).transform : null,
      editorArea: rect('.editor-area'),
      outline: rect('.outline'),
      outlineOpen: document.querySelector('.outline')?.getAttribute('aria-hidden') === 'false',
      heading: rect('.editor-tab.active .ProseMirror h1'),
      paragraph: rect('.editor-tab.active .ProseMirror p'),
      placeholder: Boolean(document.querySelector('.startup-placeholder')),
      source: rect('.source-editor:not([hidden])'),
      sourceValue: source?.value ?? null,
      sourceFont: source ? getComputedStyle(source).fontFamily : null,
      scrollTop: source?.scrollTop ?? scroller?.scrollTop ?? null,
      fileReadFinished,
      fontsLoaded: [
        document.fonts.check(`400 16px ${bodyFamily}`, '中文 Mixed'),
        document.fonts.check(`${delayedFile ? 500 : 600} 16px ${bodyFamily}`, '中文 Bold'),
        ...codeFamilies.map((family) => document.fonts.check(`400 16px ${family}`, '中文 Mixed')),
      ],
    };
  };
  type Sample = ReturnType<typeof capture>;
  const shows: Sample[] = [];
  const messages: { visible: boolean; content: string; at: number }[] = [];
  const commands: { command: string; at: number }[] = [];
  const defaults = createNativeMocks();
  const native = createNativeMocks({
    settings,
    async beforeLoadSettings() {
      settingsReadStarted = true;
      // Atomic settings use one snapshot for preferences and the recent list.
      if (!delayedFile) await settingsGate.promise;
    },
    beforeCommand(command, args) {
      commands.push({ command, at: performance.now() - began });
      if (command === 'plugin:window|show') shows.push(capture());
      if (command === 'plugin:dialog|message')
        messages.push({
          visible: native.geometry.visible,
          content: String(args.message),
          at: performance.now() - began,
        });
    },
    async fallback(command, args) {
      if (command === 'take_startup_files') {
        startupFilesTaken = true;
        return delayedRecents ? [] : [filePath];
      }
      if (command === 'read_document') {
        check(args.path === filePath, 'The fixture read an unexpected document');
        fileReadStarted = true;
        if (failedFile) throw new Error('fixture startup file unavailable');
        if (delayedFile) await fileGate.promise;
        fileReadFinished = true;
        return { path: filePath, content: markdown, revision: 'window-open:initial', mtime: 1 };
      }
      if (command === 'document_revision')
        return { path: filePath, revision: 'window-open:initial', mtime: 1 };
      return defaults.invoke(command, args);
    },
  });
  native.install();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(App));
  const samples: Sample[] = [];
  async function observe(milliseconds = 650) {
    const deadline = performance.now() + milliseconds;
    do {
      await frame();
      samples.push(capture());
    } while (performance.now() < deadline);
  }
  function stable(
    key: 'welcome' | 'logo' | 'welcomeHeading' | 'editorArea' | 'heading' | 'paragraph',
  ) {
    const first = shows[0][key];
    check(first && first[2] > 0 && first[3] > 0, `Missing first-show layout: ${key}`);
    const delta = Math.max(
      ...samples.map((sample) => {
        const next = sample[key];
        check(next, `${key} disappeared after the initial show`);
        return difference(first, next);
      }),
    );
    check(delta <= 0.5, `${key} moved after first show by ${delta}px`);
    return delta;
  }
  try {
    await until(() => settingsReadStarted && startupFilesTaken, 'native startup operations');
    if (delayedRecents) {
      for (let count = 0; count < 8; count++) await frame();
      check(!shows.length, 'The window became visible before its delayed recent list arrived');
      check(
        !document.querySelector('.welcome'),
        'An incomplete welcome page flashed while loading',
      );
      settingsGate.resolve();
    } else if (delayedPreferences) {
      await until(
        () => document.querySelector('.editor-tab.active .ProseMirror h1'),
        'file mounted independently of the pending preferences',
      );
      check(!shows.length, 'The window became visible before its saved outline preference');
      settingsGate.resolve();
    } else if (failedFile) {
      await until(() => fileReadStarted, 'startup file failure');
      for (let count = 0; count < 8; count++) await frame();
      check(!shows.length && !messages.length, 'A hidden parent window received an error dialog');
      settingsGate.resolve();
    } else await until(() => fileReadStarted, 'held command-line document read');

    await until(
      () => shows.length && native.calls.some((call) => call.command === 'plugin:window|set_focus'),
      'first window show and focus',
    );
    const first = shows[0];
    check(
      first.fontsLoaded.every(Boolean),
      'Selected body/code fonts were unavailable at first show',
    );
    check(
      first.theme === (delayedPreferences || delayedFile ? 'dark' : 'light'),
      'The window first showed the wrong saved theme',
    );
    const layoutDeltas: Record<string, number> = {};
    if (delayedRecents) {
      check(
        first.welcome &&
          first.recentNames.join('|') === recentFiles.map((file) => file.name).join('|') &&
          first.recentDirectories.join('|') ===
            recentFiles.map(() => 'C:/window-open-fixture/').join('|'),
        'The first visible welcome page did not include all five delayed file names and directories',
      );
      await observe();
      for (const key of ['welcome', 'logo', 'welcomeHeading', 'editorArea'] as const)
        layoutDeltas[key] = stable(key);
      check(
        [first, ...samples].every(
          (sample) => sample.welcomeOpacity === 1 && sample.welcomeTransform === 'none',
        ),
        'The visible welcome page faded or transformed after startup',
      );
    } else if (delayedPreferences) {
      check(
        first.outlineOpen &&
          first.outline &&
          Math.abs(first.outline[2] - 248) <= 0.5 &&
          first.editorArea &&
          Math.abs(first.editorArea[0] - first.outline[0] - first.outline[2]) <= 0.5,
        'The first visible editor did not have the saved outline width and final position',
      );
      check(first.heading && !first.welcome && !first.source, 'Saved rich document view was lost');
      await observe();
      for (const key of ['editorArea', 'heading', 'paragraph'] as const)
        layoutDeltas[key] = stable(key);
      check(
        [first, ...samples].every((sample) => sample.scrollTop === 0 && sample.outlineOpen),
        'Startup focus or outline restoration moved the editor scroll',
      );
    } else if (delayedFile) {
      check(
        !fileReadFinished && first.placeholder && !first.welcome && !first.heading,
        'The held file read blocked showing the loading view or flashed the welcome page',
      );
      await observe(200);
      check(!fileReadFinished, 'The file read gate did not remain pending after first show');
      check(
        samples.every((sample) => !sample.welcome),
        'Welcome flashed before the document arrived',
      );
      fileGate.resolve();
      await until(
        () =>
          document.querySelector('.editor-tab.active .ProseMirror h1') &&
          document.querySelector<HTMLTextAreaElement>('.source-textarea')?.value === markdown,
        'command-line file rendered with its original source',
        () => samples.push(capture()),
      );
      await observe();
      layoutDeltas.editorArea = stable('editorArea');
      const editor = document.querySelector('.editor-tab.active .ProseMirror')!;
      const code = editor.querySelector('code');
      check(
        samples.every((sample) => !sample.welcome) &&
          getComputedStyle(editor).fontFamily.includes('MDPlus LXGW WenKai') &&
          code &&
          getComputedStyle(code).fontFamily.includes('MDPlus Cascadia Code') &&
          getComputedStyle(code).fontFamily.includes('MDPlus MiSans'),
        'Late document mounting lost the body/code font preference or flashed welcome',
      );
    } else {
      await until(
        () =>
          native.geometry.visible &&
          document.querySelector('.app[data-starting="false"]') &&
          document.querySelector('.welcome') &&
          document
            .querySelector('.session-restore-notice')
            ?.textContent?.includes('fixture startup file unavailable'),
        'visible startup error',
      );
      const showIndex = commands.findIndex((entry) => entry.command === 'plugin:window|show');
      const focusIndex = commands.findIndex((entry) => entry.command === 'plugin:window|set_focus');
      check(
        showIndex >= 0 && showIndex < focusIndex && messages.length === 0,
        'The aggregated startup error blocked revealing and focusing its parent window',
      );
      check(
        document.querySelector('.session-restore-notice li')?.textContent?.includes(filePath) &&
          document.querySelector('.session-restore-notice button')?.textContent === '重试恢复',
        'The failed launch file was not identified with a retryable error',
      );
      check(
        !document.querySelector('.welcome-recent-item') &&
          JSON.stringify(settings.get('recent-files')) === '[]',
        'The failed startup document remained in the recent list',
      );
      await observe(200);
    }
    check(shows.length === 1, `Startup showed the window ${shows.length} times`);
    const firstShowIndex = commands.findIndex((entry) => entry.command === 'plugin:window|show');
    check(
      ['plugin:window|set_size', 'plugin:window|set_position', 'plugin:window|maximize'].every(
        (command) => {
          const index = commands.findIndex((entry) => entry.command === command);
          return index >= 0 && index < firstShowIndex;
        },
      ),
      'Window restoration was issued after first show',
    );
    return `${testCase}: ${JSON.stringify({ firstShow: first, sampleCount: samples.length, layoutDeltas, messages, commands })}`;
  } finally {
    settingsGate.resolve();
    fileGate.resolve();
    root.unmount();
    host.remove();
  }
}
