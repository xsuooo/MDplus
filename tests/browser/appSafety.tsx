import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import App from '../../src/App';
import { getImageUrls } from '../../src/lib/imagePaths';
import { getThemeMode } from '../../src/lib/store';
import { DEFAULT_SHORTCUTS } from '../../src/lib/shortcuts';

// Real App, React and Milkdown. Only the native IPC boundary is simulated.
// Run one case per page load to isolate module-level stores and browser timers.
export const safetyCases = [
  'close-cleanup-failure',
  'window-cleanup-failure',
  'window-destroy-failure',
  'close-save-failure',
  'settings-read-failure-retry',
  'settings-write-failure-retry',
  'settings-late-read-user-change',
  'window-restore-failure',
  'save-immediately',
  'close-immediately',
  'source-immediately',
  'edit-during-save',
  'reload-clean',
  'edit-during-confirm',
  'edit-during-read',
  'edit-during-mtime',
  'close-during-read',
  'switch-during-read',
  'source-during-read',
  'render-during-read',
  'disk-during-read',
  'image-save-stay',
  'image-save-switch',
  'image-saveas-switch',
  'image-save-enter-source',
  'source-images-new',
  'source-images-existing',
  'source-images-toggle',
  'source-images-toggle-recovery',
  'source-images-save-failure',
  'edit-during-window-close',
  'edit-after-final-close-confirm',
  'cancel-during-close-save',
  'cancel-during-window-save',
  'cancel-during-close-cleanup',
  'duplicate-close-actions',
  'window-restore-125',
  'window-restore-150',
  'external-change-same-mtime',
  'disk-during-read-same-mtime',
  'external-change-same-mtime-background',
  'external-change-same-mtime-decline',
  'same-file-path-alias',
  'same-file-relative-path',
  'same-file-extended-path',
  'same-file-concurrent-open',
  'saveas-path-collision',
  'saveas-relative-current',
  'large-source-input',
  'large-source-image-input',
  'large-new-source-image-input',
  'source-save-selection',
  'source-autosave-selection',
  'rendered-save-selection',
  'background-save-focus',
  'source-save-wrapped-reference',
  'theme-preference-startup',
  'settings-load-retry-startup',
  'no-edit-reference-links',
  'no-edit-bare-autolinks',
  'image-reference-source',
  'image-reference-reload',
  'image-reference-refresh',
  'image-reference-touch-refresh',
  'image-reference-saveas-edit',
  'image-reference-saveas-undo',
  'image-reference-recovery',
  'save-paused-feedback',
  'drop-unsupported-feedback',
  'drop-mixed-feedback',
  'file-identity-feedback',
  'print-action-label',
] as const;
export type SafetyCase = (typeof safetyCases)[number];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function until(condition: () => unknown, message: string) {
  const deadline = performance.now() + 7000;
  while (!condition()) {
    check(performance.now() < deadline, `Timed out: ${message}`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  check(button && !button.disabled, `Missing/enabled button: ${selector}`);
  button.click();
}

async function insert(text: string) {
  const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror');
  check(editor, 'Editor is not mounted');
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  check(document.execCommand('insertText', false, text), 'Browser insertion failed');
  // ProseMirror observes native DOM input in a microtask. A real click is a later task;
  // yield the observer delivery, without waiting for any content notification timer.
  await Promise.resolve();
}

function text() {
  return document.querySelector('.editor-tab.active .ProseMirror')?.textContent ?? '';
}

export async function runAppSafetyRegression(testCase: SafetyCase): Promise<string> {
  // Explicit native aliases, independent of the frontend's identity implementation.
  const aliases = new Map([
    ['C:/notes/./a.md', 'C:/notes/a.md'],
    ['C:/notes/sub/../a.md', 'C:/notes/a.md'],
    ['a.md', 'C:/notes/a.md'],
    ['\\\\?\\C:\\notes\\a.md', 'C:/notes/a.md'],
  ]);
  const nativePath = (path: unknown) => aliases.get(String(path)) ?? String(path);
  const files = new Map([
    ['C:/notes/a.md', { content: 'original\n', mtime: 100 }],
    ['C:/notes/b.md', { content: 'other document\n', mtime: 100 }],
  ]);
  const noEditRaw =
    testCase === 'no-edit-reference-links'
      ? '[Full][id] [collapsed][] [shortcut]\n\n[id]: https://example.com/full "title"\n[collapsed]: https://example.com/collapsed\n[shortcut]: https://example.com/shortcut\n'
      : testCase === 'no-edit-bare-autolinks'
        ? 'Visit https://example.com/path?q=1&x=2. Email audit@example.com.\n'
        : null;
  if (noEditRaw !== null) files.set('C:/notes/a.md', { content: noEditRaw, mtime: 100 });
  const imageCase = testCase.startsWith('image-save');
  const imageReferenceCase = testCase.startsWith('image-reference-');
  const continuityCase = [
    'source-save-selection',
    'source-autosave-selection',
    'rendered-save-selection',
    'background-save-focus',
    'source-save-wrapped-reference',
  ].includes(testCase);
  const sourceImageCase = testCase.startsWith('source-images-');
  if (sourceImageCase) files.set('C:/notes/a.md', { content: '', mtime: 100 });
  if (imageCase)
    files.set('C:/notes/a.md', {
      content: 'document A\n\n![photo](./img/pic.png "caption")\n',
      mtime: 100,
    });
  if (continuityCase)
    files.set('C:/notes/a.md', {
      content: `![photo](./img/pic.png)\n\n${Array.from({ length: 50 }, (_, i) => `## Heading ${i}\n\n段落 ${i} mixed content ${'text '.repeat(30)}\n`).join('\n')}\n![photo](./img/last.png)\n`,
      mtime: 100,
    });
  if (testCase === 'source-save-wrapped-reference') {
    const file = files.get('C:/notes/a.md')!;
    file.content = file.content.replace(
      './img/pic.png',
      `<./img/${'中文 深层目录/'.repeat(18)}photo.png>`,
    );
  }
  files.set('C:/export/a.md', { content: '', mtime: 100 });
  const themeStartupCase = testCase === 'theme-preference-startup';
  const settingsStartupCase = testCase === 'settings-load-retry-startup';
  const windowRestoreCase = testCase.startsWith('window-restore-');
  const scaleFactor = testCase === 'window-restore-125' ? 1.25 : 1.5;
  // These physical dimensions also satisfy Tauri's logical minimums at 150%.
  const savedBounds = { width: 1200, height: 900, x: 240, y: 120, maximized: false };
  const bounds = { ...savedBounds };
  const restoredBounds: (typeof savedBounds)[] = [];
  const store = new Map<string, unknown>(
    themeStartupCase
      ? [['theme-mode', 'dark']]
      : settingsStartupCase
        ? [
            ['theme-mode', 'dark'],
            ['outline-open', true],
            ['shortcuts', { ...DEFAULT_SHORTCUTS, new: null }],
          ]
        : windowRestoreCase
          ? [['window-state', savedBounds]]
          : [],
  );
  const settingsReadGate = deferred<void>();
  let holdSettingsRead = testCase === 'settings-late-read-user-change';
  let failSettingsRead = testCase === 'settings-read-failure-retry';
  let failSettingsSave = false;
  let failCleanup = testCase === 'close-cleanup-failure' || testCase === 'window-cleanup-failure';
  let failDestroy = testCase === 'window-destroy-failure';
  let failWindowRead = testCase === 'window-restore-failure';
  if (testCase.startsWith('settings-')) store.set('theme-mode', 'dark');
  if (holdSettingsRead) store.set('theme-mode', 'system');
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
    event.preventDefault();
  };
  window.addEventListener('unhandledrejection', onUnhandled);
  const settingsWrites: string[] = [];
  let storeLoads = 0;
  const themeOperations: string[] = [];
  const writes: string[] = [];
  const binaries = new Map<string, number[]>();
  const recoveryImageBytes = new Map<string, number[]>();
  const recoverySnapshots: { markdown: string; images: { key: string; placeholder: string }[] }[] =
    [];
  const imageReadGate = deferred<void>();
  let awaitingImageRead = false;
  let holdImageRead = testCase === 'image-reference-recovery';
  let expectedReferenceImage: number[] = [];
  let expectedReferenceSource = '';
  if (imageReferenceCase) {
    const image = (color: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const context = canvas.getContext('2d')!;
      context.fillStyle = color;
      context.fillRect(0, 0, 2, 2);
      const source = canvas.toDataURL('image/png');
      return {
        source,
        bytes: Array.from(atob(source.split(',')[1]), (char) => char.charCodeAt(0)),
      };
    };
    const oldImage = image('#c0392b');
    const newImage = image('#2471a3');
    const expectedImage =
      testCase === 'image-reference-saveas-edit' || testCase === 'image-reference-saveas-undo'
        ? oldImage
        : newImage;
    expectedReferenceImage = expectedImage.bytes;
    expectedReferenceSource = expectedImage.source;
    binaries.set('C:/notes/img/pic.png', oldImage.bytes);
    binaries.set('C:/notes/img/next.png', newImage.bytes);
    files.set('C:/notes/a.md', {
      content:
        testCase === 'image-reference-source' || testCase === 'image-reference-recovery'
          ? '# Reference\n'
          : '# Reference\n\n![](./img/pic.png)\n',
      mtime: 100,
    });
  }
  const writePaths: string[] = [];
  const messages: string[] = [];
  const unexpected: string[] = [];
  const confirmation = deferred<string>();
  const readGate = deferred<void>();
  const mtimeGate = deferred<void>();
  const writeGate = deferred<void>();
  let holdRead = false;
  let holdMtime = false;
  let awaitingRead = false;
  let awaitingMtime = false;
  let awaitingWrite = false;
  let didReloadRead = false;
  let holdConfirmation = false;
  let holdWrite = false;
  let confirms = 0;
  let revisionChecks = 0;
  let reloadAnswer = 'Yes';
  let completedRead = false;
  let destroyed = 0;
  const windowStateGate = deferred<void>();
  let holdWindowState = false;
  let awaitingWindowState = false;
  const cleanupGate = deferred<void>();
  let holdCleanup = false;
  let awaitingCleanup = false;
  let openPath = 'C:/notes/b.md';
  let savePath: string | null = null;
  let initialReads = 0;
  let failWrite = testCase === 'source-images-save-failure';

  mockWindows('main');
  Object.assign(globalThis, { isTauri: true });
  mockIPC(
    async (command, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      switch (command) {
        case 'list_recovery_snapshots':
          return [];
        case 'cache_recovery_image':
          recoveryImageBytes.set(String(args.key), args.data as number[]);
          return;
        case 'write_recovery_snapshot':
          recoverySnapshots.push(args.snapshot as (typeof recoverySnapshots)[number]);
          return;
        case 'delete_recovery_snapshot':
          if (failCleanup) {
            failCleanup = false;
            throw new Error('recovery cleanup unavailable');
          }
          if (holdCleanup) {
            awaitingCleanup = true;
            await cleanupGate.promise;
          }
          return;
        case 'take_startup_files':
          return testCase === 'same-file-concurrent-open'
            ? ['C:/notes/a.md', 'a.md']
            : ['C:/notes/a.md'];
        case 'take_pending_open_files':
          return [];
        case 'load_settings':
          storeLoads += 1;
          if (settingsStartupCase && storeLoads === 1)
            throw new Error('transient initial settings failure');
          return 1;
        case 'plugin:store|get':
          if (failSettingsRead) throw new Error('settings read unavailable');
          if (holdSettingsRead && args.key === 'theme-mode') {
            const old = store.get('theme-mode');
            await settingsReadGate.promise;
            return [old, true];
          }
          if (args.key === 'theme-mode') themeOperations.push('get');
          return [store.get(String(args.key)), store.has(String(args.key))];
        case 'plugin:store|set':
          settingsWrites.push(String(args.key));
          if (args.key === 'theme-mode') themeOperations.push('set');
          store.set(String(args.key), args.value);
          return;
        case 'plugin:store|save':
          if (failSettingsSave) throw new Error('settings save unavailable');
          return;
        case 'plugin:window|is_minimized':
          if (failWindowRead) {
            failWindowRead = false;
            throw new Error('window state unavailable');
          }
          return false;
        case 'plugin:window|is_maximized':
          return false;
        case 'plugin:window|inner_size':
          if (holdWindowState) {
            awaitingWindowState = true;
            await windowStateGate.promise;
          }
          return windowRestoreCase
            ? { width: bounds.width, height: bounds.height }
            : { width: 1000, height: 700 };
        case 'plugin:window|outer_position':
          return windowRestoreCase ? { x: bounds.x, y: bounds.y } : { x: 0, y: 0 };
        case 'plugin:window|set_size': {
          const value = JSON.parse(JSON.stringify(args.value)) as {
            Logical?: { width: number; height: number };
            Physical?: { width: number; height: number };
          };
          const size = value.Logical ?? value.Physical!;
          const multiplier = value.Logical ? scaleFactor : 1;
          bounds.width = Math.round(size.width * multiplier);
          bounds.height = Math.round(size.height * multiplier);
          return;
        }
        case 'plugin:window|set_position': {
          const value = JSON.parse(JSON.stringify(args.value)) as {
            Logical?: { x: number; y: number };
            Physical?: { x: number; y: number };
          };
          const position = value.Logical ?? value.Physical!;
          const multiplier = value.Logical ? scaleFactor : 1;
          bounds.x = Math.round(position.x * multiplier);
          bounds.y = Math.round(position.y * multiplier);
          restoredBounds.push({ ...bounds });
          return;
        }
        case 'plugin:window|available_monitors':
          return [];
        case 'plugin:window|show':
        case 'plugin:window|set_focus':
          return;
        case 'plugin:window|destroy':
          if (failDestroy) {
            failDestroy = false;
            throw new Error('window destruction unavailable');
          }
          destroyed += 1;
          return;
        case 'plugin:dialog|open':
          return openPath;
        case 'plugin:dialog|save':
          if (savePath !== null) return savePath;
          if (
            imageReferenceCase &&
            (args.options as { title?: string } | undefined)?.title === '导出 HTML'
          )
            return 'C:/export/result.html';
          return testCase === 'image-saveas-switch' ||
            imageReferenceCase ||
            testCase === 'save-paused-feedback'
            ? 'C:/export/a.md'
            : 'C:/notes/a.md';
        case 'plugin:path|dirname':
          return String(args.path).replace(/\/[^/]+$/, '');
        case 'plugin:path|join':
          return (args.paths as string[]).join('/').replace('/./', '/');
        case 'read_image_file': {
          if (imageReferenceCase) {
            const path =
              String(args.docPath).replace(/\/[^/]+$/, '') + '/' + String(args.relativePath);
            const data = binaries.get(path);
            check(data, `Missing referenced image ${path}`);
            if (holdImageRead) {
              awaitingImageRead = true;
              await imageReadGate.promise;
            }
            return { path, mime: 'image/png', data };
          }
          if (!sourceImageCase)
            return {
              path: continuityCase ? `C:/notes/${args.relativePath}` : 'C:/notes/img/pic.png',
              mime: 'image/png',
              data: [65, 66, 67],
            };
          const path = `C:/notes/${args.relativePath}`;
          check(binaries.has(path), `Image was not saved: ${path}`);
          return { path, mime: 'image/png', data: binaries.get(path) };
        }
        case 'save_image_asset': {
          const directory = String(args.docPath).replace(/\/[^/]+$/, '') + '/assets';
          const originalName = String(args.filename);
          const dot = originalName.lastIndexOf('.');
          let filename = originalName;
          for (let index = 1; binaries.has(`${directory}/${filename}`); index++) {
            filename = `${originalName.slice(0, dot)}-${index}${originalName.slice(dot)}`;
          }
          const path = `${directory}/${filename}`;
          binaries.set(path, args.data as number[]);
          return { filename, relativePath: `./assets/${filename}`, path };
        }
        case 'plugin:dialog|message': {
          const message = String(args.message);
          messages.push(message);
          if (message.includes('重新加载文件')) {
            confirms += 1;
            return holdConfirmation ? confirmation.promise : reloadAnswer;
          }
          if (
            message.includes('已存在。是否用当前文档替换') ||
            (imageReferenceCase && message.includes('将导出可离线'))
          )
            return 'Yes';
          return args.buttons === 'YesNo' ? 'No' : 'Ok';
        }
        case 'read_document': {
          const path = nativePath(args.path);
          const file = files.get(path);
          check(file, `Unknown file: ${args.path}`);
          // The native snapshot binds content and revision before an asynchronous caller resumes.
          const snapshot = {
            path,
            content: file.content,
            revision: `mock:${file.content}`,
            mtime: file.mtime,
          };
          initialReads += 1;
          if (holdRead && args.path === 'C:/notes/a.md') {
            awaitingRead = true;
            await readGate.promise;
            completedRead = true;
          }
          if (confirms > 0) didReloadRead = true;
          return snapshot;
        }
        case 'document_revision': {
          revisionChecks += 1;
          if (holdMtime && didReloadRead && args.path === 'C:/notes/a.md') {
            awaitingMtime = true;
            await mtimeGate.promise;
          }
          const path = nativePath(args.path);
          const file = files.get(path);
          return file
            ? { path, revision: `mock:${file.content}`, mtime: file.mtime }
            : { path, revision: null, mtime: null };
        }
        case 'export_html':
        case 'write_document': {
          if (imageReferenceCase && command === 'export_html')
            check(
              args.path === 'C:/export/result.html',
              'HTML export must not overwrite the Markdown fixture',
            );
          writes.push(String(args.content));
          writePaths.push(String(args.path));
          if (failWrite) {
            failWrite = false;
            throw new Error('simulated disk write failure');
          }
          if (holdWrite) {
            awaitingWrite = true;
            await writeGate.promise;
          }
          const path = nativePath(args.path);
          const file = files.get(path);
          if (
            command === 'write_document' &&
            args.expectedRevision !== (file ? `mock:${file.content}` : null)
          ) {
            throw {
              code: 'CONFLICT',
              message: 'simulated revision conflict',
              path: String(args.path),
              recoveryPath: null,
              backupPath: null,
              actualRevision: file ? `mock:${file.content}` : null,
              writeState: 'unchanged',
            };
          }
          const saved = { content: String(args.content), mtime: (file?.mtime ?? 99) + 1 };
          files.set(path, saved);
          return command === 'write_document'
            ? { path, revision: `mock:${saved.content}`, mtime: saved.mtime, backupPath: null }
            : undefined;
        }
        default:
          unexpected.push(command);
          throw new Error(`Unmocked IPC: ${command}`);
      }
    },
    { shouldMockEvents: true },
  );

  if (themeStartupCase) {
    await getThemeMode(); // A ready native store exposes layout/passive effect ordering.
    themeOperations.length = 0;
  }
  const host = document.createElement('div');
  document.body.append(host);
  let root = createRoot(host);
  root.render(<App />);
  await until(() => document.querySelector('.editor-tab.active .ProseMirror'), 'ready editor');
  // Wait for EditorTab's initial-state effect, not Milkdown's former content debounce.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (themeStartupCase) {
    check(
      themeOperations[0] === 'get',
      'Initial layout overwrote the saved theme before reading it',
    );
    await until(
      () => document.documentElement.dataset.theme === 'dark' && store.get('theme-mode') === 'dark',
      'saved dark theme',
    );
    click('button[aria-label="切换主题,当前为深色"]');
    await until(() => store.get('theme-mode') === 'system', 'explicit system theme persisted');
    check(
      document.documentElement.dataset.theme ===
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      'Stored system choice did not resolve to the system appearance',
    );
    return `${testCase}: saved dark preference survives startup; explicit choice still persists`;
  }
  const save = () => click('button[title^="保存 (Ctrl+S)"]');
  const close = () => click('.tab.active .tab-close');
  const source = () => click('button[title*="源码"]');
  const dirty = () =>
    document.querySelector('.tab.active .tab-dot')?.getAttribute('data-dirty') === '1';

  if (testCase === 'window-restore-failure') {
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    check(
      text().includes('original') && unhandled.length === 0,
      'Window restoration failure escaped or blocked startup',
    );
    return `${testCase}: unavailable native window metadata does not reject startup`;
  }
  if (testCase === 'settings-read-failure-retry' || testCase === 'settings-write-failure-retry') {
    if (testCase === 'settings-write-failure-retry') {
      await until(
        () => document.documentElement.dataset.theme === 'dark',
        'saved preference loaded',
      );
      failSettingsSave = true;
      click('button[aria-label^="切换主题"]');
    }
    await until(() => document.querySelector('[data-settings-error]'), 'actionable settings error');
    failSettingsRead = false;
    failSettingsSave = false;
    click('button[aria-label="重试设置"]');
    await until(() => !document.querySelector('[data-settings-error]'), 'settings retry completes');
    check(
      store.get('theme-mode') === (testCase === 'settings-read-failure-retry' ? 'dark' : 'system'),
      'Retry lost saved or user-selected preference',
    );
    if (testCase === 'settings-read-failure-retry')
      check(
        document.documentElement.dataset.theme === 'dark',
        'Retry did not restore the saved view',
      );
    check(unhandled.length === 0, 'Settings failure escaped its recovery boundary');
    return `${testCase}: visible failure can be retried without losing preferences`;
  }
  if (testCase === 'settings-late-read-user-change') {
    click('button[aria-label^="切换主题"]');
    await until(
      () => store.get('theme-mode') === 'dark',
      'explicit preference while startup read is pending',
    );
    holdSettingsRead = false;
    settingsReadGate.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    check(
      document.documentElement.dataset.theme === 'dark' && store.get('theme-mode') === 'dark',
      'Late startup read replaced the user choice',
    );
    return `${testCase}: explicit preference wins over a late startup result`;
  }
  if (
    testCase === 'close-cleanup-failure' ||
    testCase === 'window-cleanup-failure' ||
    testCase === 'window-destroy-failure'
  ) {
    const windowClose = testCase.startsWith('window-');
    const request = () => (windowClose ? click('button[aria-label="关闭窗口"]') : close());
    request();
    await until(() => messages.length > 0, 'close failure feedback');
    check(
      destroyed === 0 && document.querySelector('[role="tab"]'),
      'Close failure removed content',
    );
    request();
    await until(
      () => (windowClose ? destroyed === 1 : !document.querySelector('[role="tab"]')),
      'retry close succeeds',
    );
    check(unhandled.length === 0, 'Close failure rejected outside its boundary');
    return `${testCase}: failure preserves tabs and permits an explicit retry`;
  }
  if (testCase === 'close-save-failure') {
    await insert(' retained after save failure');
    close();
    await until(() => document.querySelector('#close-document-title'), 'dirty close confirmation');
    failWrite = true;
    const confirmSave = () =>
      [...document.querySelectorAll<HTMLButtonElement>('.modal-actions button')]
        .find((button) => button.textContent?.trim() === '保存')!
        .click();
    confirmSave();
    await until(() => messages.length > 0, 'save failure feedback');
    check(
      dirty() &&
        text().includes('retained after save failure') &&
        document.querySelector('#close-document-title'),
      'Failed save lost the draft or confirmation',
    );
    await until(
      () => !document.querySelector<HTMLButtonElement>('.modal-actions .btn-primary')?.disabled,
      'save retry available',
    );
    confirmSave();
    await until(() => !document.querySelector('[role="tab"]'), 'save and close retry');
    check(
      files.get('C:/notes/a.md')!.content.includes('retained after save failure'),
      'Retry did not save the retained draft',
    );
    return `${testCase}: failed save retains the draft and confirmation for retry`;
  }

  if (settingsStartupCase) {
    await until(
      () => storeLoads >= 2 && store.has('recent-files'),
      'settings load retried for opened file',
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    check(
      store.get('theme-mode') === 'dark' &&
        store.get('outline-open') === true &&
        (store.get('shortcuts') as typeof DEFAULT_SHORTCUTS).new === null,
      `Startup fallback overwrote saved preferences after a retry: ${JSON.stringify({ settingsWrites, stored: [...store] })}`,
    );
    const themeButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="切换主题"]',
    )!;
    const label = themeButton.getAttribute('aria-label')!;
    const nextMode = label.includes('浅色') ? 'dark' : label.includes('深色') ? 'system' : 'light';
    const themeWrites = settingsWrites.filter((key) => key === 'theme-mode').length;
    themeButton.click();
    await until(
      () =>
        settingsWrites.filter((key) => key === 'theme-mode').length > themeWrites &&
        store.get('theme-mode') === nextMode,
      'explicit theme change persisted after failure',
    );
    const outlineButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="打开目录"]',
    )!;
    const nextOutline = outlineButton.getAttribute('aria-pressed') !== 'true';
    const outlineWrites = settingsWrites.filter((key) => key === 'outline-open').length;
    outlineButton.click();
    await until(
      () =>
        settingsWrites.filter((key) => key === 'outline-open').length > outlineWrites &&
        store.get('outline-open') === nextOutline,
      'explicit outline change persisted after failure',
    );
    check(unexpected.length === 0, 'Unexpected IPC after settings recovery');
    return `${testCase}: retry preserves existing preferences and permits explicit updates`;
  }

  if (windowRestoreCase) {
    await until(() => restoredBounds.length === 1, 'initial window placement');
    check(
      JSON.stringify(bounds) === JSON.stringify(savedBounds),
      `Physical bounds scaled at ${scaleFactor} DPI: ${JSON.stringify(bounds)}`,
    );
    click('button[aria-label="关闭窗口"]');
    await until(() => destroyed === 1, 'window state persisted');
    check(
      JSON.stringify(store.get('window-state')) === JSON.stringify(savedBounds),
      'Window bounds drifted on persistence',
    );
    root.unmount();
    root = createRoot(host);
    root.render(<App />);
    await until(
      () =>
        restoredBounds.length === 2 && document.querySelector('.editor-tab.active .ProseMirror'),
      'second restore',
    );
    check(
      JSON.stringify(bounds) === JSON.stringify(savedBounds),
      'Repeated restore scaled the saved physical bounds again',
    );
    check(unexpected.length === 0, 'Unexpected IPC during window restoration');
    return `${testCase}: physical dimensions and position survive repeated restore at ${scaleFactor} DPI`;
  }

  if (testCase === 'edit-after-final-close-confirm') {
    await insert(' dirty A');
    click('button[title="打开 (Ctrl+O)"]');
    await until(() => text().includes('other document'), 'clean second document');
    holdWindowState = true;
    click('button[aria-label="关闭窗口"]');
    await until(
      () => document.querySelector('#close-document-title'),
      'dirty document confirmation',
    );
    const discard = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent === '放弃');
    check(discard, 'Missing discard button');
    discard.click();
    await until(() => awaitingWindowState, 'final metadata after confirming dirty document');
    await insert(' unconfirmed B input');
    windowStateGate.resolve();
    await until(
      () =>
        destroyed > 0 ||
        document.querySelector('.presence:not([data-exiting]) #close-document-title'),
      'final close outcome',
    );
    check(
      destroyed === 0 && text().includes('unconfirmed B input'),
      'Window destroyed with new unconfirmed edits in the remaining tab',
    );
    await until(
      () =>
        recoverySnapshots.some((snapshot) => snapshot.markdown.includes('unconfirmed B input')) ||
        writes.some((write) => write.includes('unconfirmed B input')),
      'remaining draft protected',
    );
    check(
      document.querySelector('#close-document-title')?.textContent?.includes('b.md'),
      'Remaining dirty document was not confirmed',
    );
    check(unexpected.length === 0, 'Unexpected IPC during final close');
    return `${testCase}: final close rechecks and protects newly edited remaining tabs`;
  }

  if (testCase === 'cancel-during-close-save' || testCase === 'cancel-during-window-save') {
    await insert(' draft before closing');
    if (testCase === 'cancel-during-window-save') click('button[aria-label="关闭窗口"]');
    else close();
    await until(() => document.querySelector('#close-document-title'), 'close dialog');
    holdWrite = true;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    const saveButton = buttons.find((button) => button.textContent === '保存');
    const cancelButton = buttons.find((button) => button.textContent === '取消');
    check(saveButton && cancelButton, 'Missing save/cancel buttons');
    saveButton.click();
    await until(() => awaitingWrite, 'save in progress');
    cancelButton.click();
    await until(
      () => !document.querySelector('.presence:not([data-exiting]) #close-document-title'),
      'cancel acknowledged',
    );
    writeGate.resolve();
    await until(
      () => files.get('C:/notes/a.md')?.content.includes('draft before closing'),
      'save finishes',
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    check(
      document.querySelectorAll('[role="tab"]').length === 1 && destroyed === 0,
      'Cancelled close continuation still removed the tab',
    );
    check(!dirty() && writes.length === 1, 'Cancellation interfered with the successful save');
    if (testCase === 'cancel-during-window-save') {
      click('button[aria-label="关闭窗口"]');
      await until(() => destroyed === 1, 'retry window close after cancellation');
    }
    return `${testCase}: cancel retains the tab while its in-flight save completes`;
  }

  if (testCase === 'cancel-during-close-cleanup') {
    await insert(' draft during cleanup');
    close();
    await until(() => document.querySelector('#close-document-title'), 'close dialog');
    holdCleanup = true;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    buttons.find((button) => button.textContent === '放弃')!.click();
    await until(() => awaitingCleanup, 'held recovery cleanup');
    buttons.find((button) => button.textContent === '取消')!.click();
    holdCleanup = false;
    cleanupGate.resolve();
    await until(
      () => !document.querySelector('.presence:not([data-exiting]) #close-document-title'),
      'cleanup close cancelled',
    );
    await until(
      () =>
        recoverySnapshots.some((snapshot) => snapshot.markdown.includes('draft during cleanup')) ||
        writes.some((write) => write.includes('draft during cleanup')),
      'cancelled draft protected again',
    );
    check(
      document.querySelectorAll('[role="tab"]').length === 1 &&
        text().includes('draft during cleanup'),
      'Cancelled cleanup still discarded the draft',
    );
    return `${testCase}: cancellation invalidates cleanup and preserves recovery protection`;
  }

  if (testCase === 'duplicate-close-actions') {
    await insert(' one close decision');
    close();
    await until(() => document.querySelector('#close-document-title'), 'close dialog');
    holdWrite = true;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    const saveButton = buttons.find((button) => button.textContent === '保存')!;
    const discardButton = buttons.find((button) => button.textContent === '放弃')!;
    const cancelButton = buttons.find((button) => button.textContent === '取消')!;
    saveButton.click();
    saveButton.click();
    discardButton.click();
    await until(() => awaitingWrite, 'single held close save');
    check(
      saveButton.disabled && discardButton.disabled && !cancelButton.disabled,
      'Busy close permits conflicting decisions or disables cancellation',
    );
    check(
      document.querySelectorAll('[role="tab"]').length === 1 && writes.length === 1,
      'Duplicate actions discarded a pending save',
    );
    writeGate.resolve();
    await until(() => !document.querySelector('[role="tab"]'), 'single confirmed close');
    check(
      writes.length === 1 && files.get('C:/notes/a.md')!.content.includes('one close decision'),
      'Duplicate close wrote more than one snapshot',
    );
    return `${testCase}: one confirmation runs while cancellation remains available`;
  }

  if (testCase === 'external-change-same-mtime-background') {
    click('button[title="打开 (Ctrl+O)"]');
    await until(() => text().includes('other document'), 'background first document');
    files.set('C:/notes/a.md', { content: 'background external replacement\n', mtime: 100 });
    await until(
      () => document.querySelector('[role="tab"] .tab-dot')?.getAttribute('data-external') === '1',
      'background revision marker',
    );
    check(
      confirms === 0 && text().includes('other document'),
      'Background polling interrupted the active document',
    );
    (document.querySelector('[role="tab"]') as HTMLElement).click();
    await until(
      () => confirms === 1 && text().includes('background external replacement'),
      'background reload on activation',
    );
    check(!dirty() && writes.length === 0, 'Background reload altered the save baseline');
    return `${testCase}: same-mtime changes are deferred until the affected tab is active`;
  }

  if (testCase === 'external-change-same-mtime-decline') {
    reloadAnswer = 'No';
    files.set('C:/notes/a.md', { content: 'declined external revision\n', mtime: 100 });
    await until(() => confirms === 1, 'declined same-mtime reload');
    const checksAfterNotice = revisionChecks;
    await until(() => revisionChecks > checksAfterNotice, 'next disk poll');
    check(
      confirms === 1 && text().includes('original') && writes.length === 0,
      'Declined revision was repeatedly offered or replaced local content',
    );
    files.set('C:/notes/a.md', { content: 'another external revision\n', mtime: 100 });
    await until(() => confirms === 2, 'new bytes offered at the same timestamp');
    await insert(' local input after decline');
    save();
    await until(
      () => messages.some((message) => message.includes('选择「确定」用当前编辑内容覆盖')),
      'preserved manual-save conflict check',
    );
    check(
      files.get('C:/notes/a.md')!.content === 'another external revision\n' && writes.length === 0,
      'Declined reload advanced the saved disk revision',
    );
    return `${testCase}: notice deduplication preserves conflicts and detects subsequent revisions`;
  }

  if (testCase === 'external-change-same-mtime' || testCase === 'disk-during-read-same-mtime') {
    holdRead = testCase === 'disk-during-read-same-mtime';
    files.set('C:/notes/a.md', {
      content: 'external replacement with preserved timestamp\n',
      mtime: 100,
    });
    await until(() => confirms > 0, 'same-mtime external reload confirmation');
    if (holdRead) {
      await until(() => awaitingRead, 'held same-mtime snapshot');
      files.set('C:/notes/a.md', {
        content: 'newer replacement with the same timestamp\n',
        mtime: 100,
      });
      readGate.resolve();
      await until(
        () => messages.some((message) => message.includes('重载已取消')),
        'inconsistent snapshot rejected',
      );
      check(
        text().includes('original') && writes.length === 0,
        'Same-mtime replacement accepted an obsolete snapshot',
      );
    } else {
      await until(() => text().includes('external replacement'), 'same-mtime reload');
      check(
        !dirty() && writes.length === 0,
        'External reload changed dirty state or wrote to disk',
      );
    }
    return `${testCase}: content revisions detect unchanged timestamps and protect reload consistency`;
  }

  if (testCase.startsWith('same-file-')) {
    if (testCase === 'same-file-concurrent-open') {
      await until(() => initialReads === 2, 'both native startup snapshots');
    } else {
      openPath =
        testCase === 'same-file-relative-path'
          ? 'a.md'
          : testCase === 'same-file-extended-path'
            ? '\\\\?\\C:\\notes\\a.md'
            : 'C:/notes/./a.md';
      click('button[title="打开 (Ctrl+O)"]');
      await until(
        () => !document.querySelector<HTMLButtonElement>('button[title="打开 (Ctrl+O)"]')!.disabled,
        'alias open finished',
      );
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    check(
      document.querySelectorAll('[role="tab"]').length === 1,
      'Equivalent native paths opened duplicate tabs',
    );
    check(
      document.querySelector('.status-file-identity')?.textContent === 'C:/notes/a.md',
      'Tab retained a noncanonical file path',
    );
    check(unexpected.length === 0, 'Unexpected IPC in identity regression');
    return `${testCase}: aliases and concurrent opens share the native canonical document identity`;
  }

  if (testCase === 'saveas-path-collision' || testCase === 'saveas-relative-current') {
    if (testCase === 'saveas-path-collision') {
      click('button[title="打开 (Ctrl+O)"]');
      await until(() => text().includes('other document'), 'second document');
      await insert(' distinct B draft');
      savePath = 'C:/notes/sub/../a.md';
      click('button[title="另存为"]');
      await until(
        () => messages.some((message) => message.includes('已经打开')),
        'canonical SaveAs collision notice',
      );
      check(
        writes.length === 0 && files.get('C:/notes/a.md')!.content === 'original\n',
        'Alias SaveAs overwrote another open document',
      );
      await until(
        () => dirty() && text().includes('distinct B draft'),
        'retained source draft after collision',
      );
    } else {
      await insert(' local draft');
      files.set('C:/notes/a.md', { content: 'external conflict\n', mtime: 100 });
      savePath = 'a.md';
      click('button[title="另存为"]');
      await until(
        () => messages.some((message) => message.includes('选择「确定」用当前编辑内容覆盖')),
        'same-file SaveAs conflict check',
      );
      check(
        writes.length === 0 && dirty(),
        'Selecting a relative alias bypassed normal save conflict protection',
      );
    }
    return `${testCase}: canonical SaveAs identities preserve collision and conflict checks`;
  }

  if (
    testCase === 'large-source-input' ||
    testCase === 'large-source-image-input' ||
    testCase === 'large-new-source-image-input'
  ) {
    const newDocument = testCase === 'large-new-source-image-input';
    if (newDocument) {
      close();
      await until(() => !document.querySelector('[role="tab"]'), 'initial document closed');
      click('button[title="新建文档 (Ctrl+N)"]');
      await until(() => document.querySelector('.newfile-card'), 'new document dialog');
      click('.newfile-card');
      await until(
        () => document.querySelector('.editor-tab.active .ProseMirror'),
        'unsaved editor',
      );
    }
    source();
    await until(
      () => document.querySelector('.source-editor:not([hidden]) .source-textarea'),
      'source editor',
    );
    const input = document.querySelector<HTMLTextAreaElement>(
      '.source-editor:not([hidden]) .source-textarea',
    )!;
    const line =
      '# Heading\n\n普通段落 plain words with **bold** and [link](https://example.com).\n\n';
    const markdown =
      line.repeat(Math.ceil((1024 * 1024) / new TextEncoder().encode(line).length)) +
      (newDocument
        ? '\n![photo](https://example.com/photo.png)\n'
        : testCase === 'large-source-image-input'
          ? '\n![photo](./img/pic.png)\n'
          : '');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const costs: number[] = [];
    for (const value of [markdown, `${markdown}\nlatest input`]) {
      setter.call(input, value);
      const start = performance.now();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      costs.push(performance.now() - start);
    }
    check(
      Math.max(...costs) < 400,
      `1 MiB input handlers blocked on full Markdown parsing: ${JSON.stringify(costs)}`,
    );
    save(); // Flush the latest deferred image preparation before any write.
    await until(
      () => files.get('C:/notes/a.md')?.content.includes('latest input') && !dirty(),
      'latest large draft saved',
    );
    check(
      input.value.endsWith('latest input'),
      'Deferred preparation lost the latest source input',
    );
    check(
      getImageUrls(files.get('C:/notes/a.md')!.content).length ===
        (testCase.includes('image-input') ? 1 : 0),
      'Deferred save lost an image reference',
    );
    check(unexpected.length === 0, 'Unexpected IPC during large document input');
    return JSON.stringify({
      case: testCase,
      utf8Bytes: new TextEncoder().encode(markdown).length,
      inputHandlerMs: costs,
      scope:
        'actual SourceEditor input event and App handler; paint and native filesystem latency excluded',
    });
  }

  if (testCase === 'save-paused-feedback') {
    await insert(' local draft');
    files.set('C:/notes/a.md', { content: 'external edit\n', mtime: 200 });
    await until(
      () => messages.some((message) => message.includes('自动保存已暂停')),
      'automatic conflict notice',
    );
    await until(
      () => !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled,
      'paused save settled',
    );
    check(
      document.querySelector('.status-save')?.textContent?.includes('自动保存已暂停'),
      'Persistent pause status is missing',
    );
    const noticesBeforeSave = messages.length;
    save();
    await until(() => messages.length > noticesBeforeSave, 'manual overwrite confirmation');
    await until(
      () =>
        document.querySelector('.status-save')?.textContent === '自动保存已暂停' &&
        !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled,
      'manual conflict cancellation',
    );
    check(
      files.get('C:/notes/a.md')!.content === 'external edit\n',
      'Cancelled conflict overwrote external bytes',
    );
    check(
      document.querySelector('.status-save')?.textContent?.includes('自动保存已暂停'),
      'Cancelling overwrite falsely resumed saving',
    );
    click('button[title="另存为"]');
    await until(
      () =>
        files.get('C:/export/a.md')!.content.includes('local draft') &&
        document.querySelector('.status-save')?.textContent === '已保存',
      'SaveAs resolves pause',
    );
    check(
      files.get('C:/notes/a.md')!.content === 'external edit\n',
      'SaveAs changed the original external document',
    );
    return `${testCase}: persistent pause survives cancel; explicit SaveAs preserves both documents`;
  }
  if (testCase === 'drop-unsupported-feedback' || testCase === 'drop-mixed-feedback') {
    const mixed = testCase === 'drop-mixed-feedback';
    await emit('tauri://drag-drop', {
      paths: [...(mixed ? ['C:/notes/b.md'] : []), 'C:/notes/unsupported.txt'],
      position: { x: 1, y: 1 },
    });
    await until(
      () => messages.some((message) => message.includes('已忽略 1')),
      'unsupported dropped-file notice',
    );
    if (mixed)
      await until(() => text().includes('other document'), 'supported part of a mixed drop');
    check(
      document.querySelectorAll('[role="tab"]').length === (mixed ? 2 : 1),
      'Drop opened an unsupported path or lost a supported document',
    );
    check(unexpected.length === 0, 'Unsupported drop reached unexpected native IPC');
    return `${testCase}: unsupported paths reported without discarding supported Markdown`;
  }
  if (testCase === 'file-identity-feedback') {
    check(
      document.querySelector('.status-file-identity')?.textContent === 'C:/notes/a.md',
      'Status omits full document identity',
    );
    check(
      document.querySelector('[role="tab"]')?.getAttribute('aria-label')?.includes('C:/notes/a.md'),
      'Tab accessible name cannot distinguish same-named files',
    );
    return `${testCase}: current path is visible and accessible`;
  }
  if (testCase === 'print-action-label') {
    click('button[title="导出"]');
    await until(() => document.querySelector('[role="menuitem"]'), 'export menu');
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (button) => button.textContent === '打印 / 另存为 PDF',
    );
    check(item?.title.includes('确认保存'), 'Print action falsely implies an already saved PDF');
    return `${testCase}: print-to-PDF action requires explicit confirmation in the system dialog`;
  }

  if (testCase === 'image-reference-recovery') {
    holdWrite = true;
    source();
    await until(
      () => document.querySelector('.source-editor:not([hidden]) textarea'),
      'source editor',
    );
    const field = document.querySelector<HTMLTextAreaElement>(
      '.source-editor:not([hidden]) textarea',
    )!;
    const markdown = '# One edit\n\n![new](./img/next.png)\n';
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      field,
      markdown,
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => awaitingImageRead, 'pending image read');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    check(
      recoverySnapshots.length === 0,
      'Recovery persisted a relative-image draft before its bytes were prepared',
    );
    check(
      document.querySelector('.recovery-status-pending'),
      'Pending image bytes were advertised as protected or failed prematurely',
    );
    holdImageRead = false;
    imageReadGate.resolve();
    await until(
      () => recoverySnapshots.some((snapshot) => snapshot.images.length === 1),
      'portable recovery snapshot after one input',
    );
    const snapshot = recoverySnapshots[recoverySnapshots.length - 1];
    check(
      snapshot.markdown.includes('mdplus-image:') && !snapshot.markdown.includes('./img/next.png'),
      'Recovery retained an unusable relative image reference',
    );
    check(
      JSON.stringify(recoveryImageBytes.get(snapshot.images[0].key)) ===
        JSON.stringify(expectedReferenceImage),
      'Recovery image bytes disagree with the prepared preview',
    );
    check(field.value === markdown, 'Recovery changed the source draft');
    holdWrite = false;
    writeGate.resolve();
    return `${testCase}: a single raw-image edit waits for bytes before durable recovery protection`;
  }

  if (testCase === 'image-reference-saveas-edit' || testCase === 'image-reference-saveas-undo') {
    const undoEdit = testCase === 'image-reference-saveas-undo';
    await until(
      () =>
        document.querySelector<HTMLImageElement>('.editor-tab.active .md-image-node img')
          ?.naturalWidth,
      'initial relative image',
    );
    source();
    await until(
      () => document.querySelector('.source-editor:not([hidden]) textarea'),
      'source editor',
    );
    const field = document.querySelector<HTMLTextAreaElement>(
      '.source-editor:not([hidden]) textarea',
    )!;
    const original = field.value;
    holdWrite = true;
    click('button[title="另存为"]');
    await until(() => awaitingWrite, 'SaveAs pending write');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      field,
      original + '\nconcurrent edit',
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
    if (undoEdit) {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      await until(() => field.value === original, 'source undo restores original Markdown');
    }
    const currentDraft = undoEdit ? original : original + '\nconcurrent edit';
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    holdWrite = false;
    writeGate.resolve();
    await until(
      () => !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled,
      'SaveAs and queued save settled',
    );
    check(
      document.querySelector('.status-file-identity')?.textContent === 'C:/notes/a.md',
      'Concurrent image SaveAs changed the relative-image base',
    );
    check(field.value === currentDraft, 'Concurrent SaveAs changed the latest source');
    check(
      messages.some((message) => message.includes('副本已写入')),
      'Written snapshot and retained current draft are not distinguished',
    );
    check(
      writePaths.length === 1 && writePaths[0] === 'C:/export/a.md',
      'Queued save wrote after a base-preserving cancellation',
    );
    check(
      files.get('C:/notes/a.md')!.content === original,
      'Original Markdown changed during SaveAs',
    );
    click('button[title="另存为"]');
    await until(
      () =>
        document.querySelector('.status-file-identity')?.textContent === 'C:/export/a.md' &&
        !dirty(),
      'explicit SaveAs retry',
    );
    check(
      files.get('C:/export/a.md')!.content.includes('concurrent edit') === !undoEdit,
      'SaveAs retry persisted text that had been undone',
    );
    const url = getImageUrls(files.get('C:/export/a.md')!.content)[0];
    check(url?.startsWith('./assets/'), 'Retried SaveAs lost portable image path');
    check(
      JSON.stringify(binaries.get(`C:/export/${url.slice(2)}`)) ===
        JSON.stringify(expectedReferenceImage),
      'Retried SaveAs lost original image bytes',
    );
    return `${testCase}: concurrent relative-image draft retains its base; retry preserves latest text and bytes`;
  }

  if (imageReferenceCase) {
    if (testCase === 'image-reference-source') {
      source();
      await until(
        () => document.querySelector('.source-editor:not([hidden]) textarea'),
        'source editor',
      );
      const field = document.querySelector<HTMLTextAreaElement>(
        '.source-editor:not([hidden]) textarea',
      )!;
      const markdown = '# Reference\n\n![](./img/next.png)\n';
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        field,
        markdown,
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      source();
      await until(
        () => !document.querySelector('.source-editor:not([hidden])'),
        'rendered reference',
      );
      check(field.value === markdown, 'Resolving an image rewrote typed source');
    } else {
      await until(
        () =>
          document.querySelector<HTMLImageElement>('.editor-tab.active .md-image-node img')
            ?.naturalWidth,
        'initial image',
      );
      if (testCase === 'image-reference-refresh' || testCase === 'image-reference-touch-refresh')
        binaries.set('C:/notes/img/pic.png', expectedReferenceImage);
      const touched = testCase === 'image-reference-touch-refresh';
      files.set('C:/notes/a.md', {
        content: touched
          ? '# Reference\n\n![](./img/pic.png)\n'
          : testCase === 'image-reference-reload'
            ? '# External\n\n![](./img/pic.png)\n\n![](./img/next.png)\n'
            : '# External\n\n![](./img/pic.png)\n',
        mtime: 200,
      });
      await until(
        () => confirms > 0 && text().includes(touched ? 'Reference' : 'External'),
        'external document reload',
      );
    }
    await until(
      () =>
        Array.from(document.querySelectorAll<HTMLImageElement>('.editor-tab.active img')).some(
          (image) => image.src === expectedReferenceSource && image.naturalWidth > 0,
        ),
      'current image bytes in preview',
    );
    click('button[title="另存为"]');
    await until(
      () => files.get('C:/export/a.md')!.content.includes('./assets/'),
      'portable SaveAs references',
    );
    const portableMarkdown = files.get('C:/export/a.md')!.content;
    const references = getImageUrls(files.get('C:/export/a.md')!.content);
    const last = references[references.length - 1];
    check(last?.startsWith('./assets/'), 'SaveAs retained an unportable image path');
    check(
      JSON.stringify(binaries.get(`C:/export/${last.slice(2)}`)) ===
        JSON.stringify(expectedReferenceImage),
      'SaveAs copied stale or missing image bytes',
    );
    click('button[title="导出"]');
    await until(() => document.querySelector('[role="menuitem"]'), 'export menu');
    const htmlButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes('HTML'));
    check(htmlButton, 'HTML export action missing');
    htmlButton.click();
    await until(() => files.has('C:/export/result.html'), 'offline HTML output');
    check(
      files.get('C:/export/a.md')!.content === portableMarkdown,
      'HTML export overwrote the current Markdown document',
    );
    const exported = new DOMParser().parseFromString(
      files.get('C:/export/result.html')!.content,
      'text/html',
    );
    check(
      Array.from(exported.images).some(
        (image) => image.getAttribute('src') === expectedReferenceSource,
      ),
      'Offline export embedded stale or missing image bytes',
    );
    check(unexpected.length === 0, 'Unexpected IPC in image reference flow');
    return `${testCase}: preview, SaveAs and offline HTML agree on current bytes (native IPC mocked)`;
  }

  if (noEditRaw !== null) {
    // Let the passive initial notification settle before testing a no-edit save.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    check(!dirty(), 'Opening the original source was marked as an edit');
    save();
    await until(() => writes.length > 0, 'no-edit save write');
    check(
      writes[0] === noEditRaw,
      `No-edit save rewrote original source: ${JSON.stringify({ expected: noEditRaw, actual: writes[0] })}`,
    );
    await until(
      () => !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled,
      'no-edit save complete',
    );
    check(
      !dirty() && files.get('C:/notes/a.md')!.content === noEditRaw,
      'No-edit save changed source or dirty state',
    );
    source();
    await until(
      () => document.querySelector('.source-editor:not([hidden]) textarea'),
      'original source readback',
    );
    check(
      document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!
        .value === noEditRaw,
      'Source view lost original spelling',
    );
    source();
    await until(
      () => !document.querySelector('.source-editor:not([hidden]) textarea'),
      'return to rendered mode without editing',
    );
    save();
    await until(() => writes.length === 2, 'save after unchanged mode round trip');
    check(writes[1] === noEditRaw, 'Unchanged source/rendered round trip rewrote original source');
    check(unexpected.length === 0, 'Unexpected native IPC in preservation regression');
    return `${testCase}: exact no-edit write and source/rendered round trip preserved (native IPC mocked)`;
  }
  if (continuityCase) {
    await document.fonts.ready;
    const sourceCase = testCase.startsWith('source-');
    if (sourceCase) {
      source();
      await until(
        () => document.querySelector('.source-editor:not([hidden]) textarea'),
        'source editor',
      );
      const field = document.querySelector<HTMLTextAreaElement>(
        '.source-editor:not([hidden]) textarea',
      )!;
      const extra = ' draft edit';
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        field,
        field.value + extra,
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const at = field.value.indexOf('段落 25');
      field.focus();
      field.setSelectionRange(at, at + 5, 'backward');
      field.scrollTop = 1400;
      const selected = field.value.slice(at, at + 5);
      const top = field.scrollTop;
      const height = field.scrollHeight;
      field.dispatchEvent(new Event('select', { bubbles: true }));
      field.dispatchEvent(new Event('scroll', { bubbles: true }));
      if (testCase !== 'source-autosave-selection') save();
      await until(() => writes.length > 0 && !dirty(), 'image references saved');
      check(
        field.value.slice(field.selectionStart, field.selectionEnd) === selected,
        `Image migration displaced the selected source text: ${JSON.stringify({ selected, actual: field.value.slice(field.selectionStart, field.selectionEnd), at: field.selectionStart, expected: field.value.indexOf(selected), sourceAt: at })}`,
      );
      const expectedTop =
        testCase === 'source-save-wrapped-reference' ? top + field.scrollHeight - height : top;
      check(
        field.selectionDirection === 'backward' && Math.abs(field.scrollTop - expectedTop) <= 1,
        'Image migration moved source viewport or direction',
      );
      check(document.activeElement === field, 'Save took focus from source');
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      await until(() => !field.value.endsWith(extra), 'source undo survived migration');
      check(!field.value.includes('mdplus-image:'), 'Undo resurrected stale image placeholders');
    } else {
      const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
      const scroller = document.querySelector<HTMLElement>(
        '.editor-tab.active .milkdown-container',
      )!;
      const paragraph = Array.from(editor.querySelectorAll('p')).find((p) =>
        p.textContent?.startsWith('段落 25'),
      )!;
      editor.focus();
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(paragraph.firstChild!, 5);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      check(
        window.getSelection()?.toString() === '段落 25',
        'Fixture did not establish rendered text selection',
      );
      scroller.scrollTop = 1700;
      const top = scroller.scrollTop;
      holdWrite = testCase === 'background-save-focus';
      save();
      if (holdWrite) {
        await until(() => awaitingWrite, 'blocked background write');
        click('button[title="打开 (Ctrl+O)"]');
        await until(() => text().includes('other document'), 'other tab opened');
        source();
        await until(
          () => document.querySelector('.source-editor:not([hidden]) textarea'),
          'other source',
        );
        const other = document.querySelector<HTMLTextAreaElement>(
          '.source-editor:not([hidden]) textarea',
        )!;
        other.focus();
        writeGate.resolve();
        await until(
          () =>
            !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled,
          'background save complete',
        );
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        check(document.activeElement === other, 'Background image save stole the other tab focus');
        click('[role="tab"]');
        await until(
          () => document.querySelector('.editor-tab.active .ProseMirror')?.contains(paragraph),
          'original tab restored',
        );
        check(scroller.scrollTop === top, 'Background image save lost the saved viewport');
      } else {
        await until(() => writes.length > 0 && !dirty(), 'rendered image save complete');
        check(
          window.getSelection()?.toString() === '段落 25',
          'Image migration lost rendered text selection',
        );
        check(
          scroller.scrollTop === top && document.activeElement === editor,
          `Image migration jumped or stole focus: top ${scroller.scrollTop} expected ${top}, focus ${document.activeElement?.className}`,
        );
      }
    }
  } else if (testCase === 'edit-during-window-close') {
    holdWindowState = true;
    click('button[aria-label="关闭窗口"]');
    await until(() => awaitingWindowState, 'pending close metadata');
    await insert(' input while closing');
    windowStateGate.resolve();
    await until(
      () => document.querySelector('#close-document-title') || destroyed > 0,
      'close outcome',
    );
    check(
      destroyed === 0 && text().includes('input while closing'),
      'Window close lost input made during metadata persistence',
    );
  } else if (sourceImageCase) {
    if (testCase === 'source-images-new') {
      close();
      await until(() => !document.querySelector('[role="tab"]'), 'close initial document');
      click('button[title="新建文档 (Ctrl+N)"]');
      await until(() => document.querySelector('.newfile-card'), 'new document dialog');
      click('.newfile-card');
      await until(() => document.querySelector('.editor-tab.active .ProseMirror'), 'new editor');
    }
    const labels = Array.from(
      document.querySelectorAll('.toolbar-file-actions .toolbar-btn-label'),
      (element) => element.textContent,
    );
    check(
      labels.filter((label) => label === '保存').length === 1 &&
        labels.filter((label) => label === '另存为').length === 1,
      'Duplicate Save As labels',
    );
    source();
    await until(
      () => document.querySelector('.source-editor:not([hidden]) .source-textarea'),
      'source editor',
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const field = () =>
      document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')!;
    const pixel = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    );
    for (let i = 0; i < 4; i++) {
      const input = field();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([pixel], `pasted-${i}.png`, { type: 'image/png' }));
      input.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
      await until(() => getImageUrls(field().value).length === i + 1, 'pasted image reference');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const draft = field().value;
    const renderedImages = () =>
      Array.from(
        document.querySelectorAll<HTMLImageElement>(
          '.editor-tab.active .ProseMirror img:not(.ProseMirror-separator)',
        ),
      );
    if (testCase === 'source-images-toggle' || testCase === 'source-images-toggle-recovery') {
      if (testCase === 'source-images-toggle-recovery') holdWrite = true;
      source();
      await until(
        () => !document.querySelector('.source-editor:not([hidden]) .source-textarea'),
        'leave source before save',
      );
      await until(() => renderedImages().length === 4, 'four rendered images before save');
      if (testCase === 'source-images-toggle-recovery') {
        await until(
          () => recoverySnapshots.some((snapshot) => snapshot.images.length === 4),
          'four image references protected after mode switch',
        );
        const snapshot = recoverySnapshots.find((item) => item.images.length === 4)!;
        check(
          getImageUrls(snapshot.markdown).length === 4 &&
            snapshot.images.every((image) => recoveryImageBytes.has(image.key)),
          'Mode switch recovery omitted pasted image bytes',
        );
        holdWrite = false;
        writeGate.resolve();
        await until(
          () => getImageUrls(files.get('C:/notes/a.md')!.content).length === 4 && !dirty(),
          'latest image draft saved after recovery',
        );
        return `${testCase}: switching modes revalidates the source snapshot and retains all pasted image bytes`;
      }
    }
    save();
    if (testCase === 'source-images-save-failure') {
      await until(
        () => messages.some((message) => message.includes('simulated disk write failure')),
        'save error',
      );
      check(field().value === draft, 'Failed save replaced the source draft');
      await until(dirty, 'failed save remains unsaved');
      await until(
        () =>
          !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled,
        'retry enabled',
      );
      save();
    }
    await until(
      () => getImageUrls(files.get('C:/notes/a.md')!.content).length === 4,
      'four saved image references',
    ).catch((error: unknown) => {
      throw new Error(
        `${String(error)}; ${JSON.stringify({ messages, writes, disk: files.get('C:/notes/a.md'), rendered: text(), unexpected })}`,
      );
    });
    await until(() => !dirty(), 'save completion');
    const saved = files.get('C:/notes/a.md')!.content;
    check(!saved.includes('mdplus-image:'), 'Saved Markdown contains temporary image tokens');
    for (const url of getImageUrls(saved)) {
      check(
        binaries.get(`C:/notes/${url.replace(/^\.\//, '')}`)?.length === pixel.length,
        'Saved image bytes are missing',
      );
    }
    if (document.querySelector('.source-editor:not([hidden]) .source-textarea')) source();
    await until(
      () =>
        renderedImages().length === 4 && renderedImages().every((image) => image.naturalWidth > 0),
      'four loaded previews',
    );
    source();
    await until(
      () => getImageUrls(field()?.value ?? '').length === 4,
      'images after mode round trip',
    );
    close();
    await until(() => !document.querySelector('[role="tab"]'), 'close saved document');
    openPath = 'C:/notes/a.md';
    click('button[title="打开 (Ctrl+O)"]');
    await until(
      () =>
        renderedImages().length === 4 && renderedImages().every((image) => image.naturalWidth > 0),
      'four images after reopen',
    );
    check(files.get('C:/notes/a.md')!.content === saved, 'Reopening rewrote the saved document');
  } else if (testCase === 'save-immediately') {
    await insert(' last character');
    save();
    await until(() => writes.length > 0, 'save call');
    check(writes[0].includes('last character'), 'F01: immediate save lost the last input');
  } else if (testCase === 'close-immediately') {
    await insert(' last character');
    close();
    await until(
      () => document.querySelector('[role="dialog"]') || !document.querySelector('[role="tab"]'),
      'close outcome',
    );
    check(
      document.querySelector('[role="dialog"]'),
      'F01: immediate close skipped unsaved confirmation',
    );
    check(document.querySelector('[role="tab"]'), 'F01: unsaved tab was removed');
  } else if (testCase === 'source-immediately') {
    await insert(' last character');
    source();
    await until(
      () => document.querySelector('.source-editor:not([hidden]) .source-textarea'),
      'source editor',
    );
    check(
      document
        .querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')
        ?.value.includes('last character'),
      'F01: source switch lost the last input',
    );
  } else if (testCase === 'edit-during-save') {
    holdWrite = true;
    await insert(' saved edit');
    save();
    await until(() => awaitingWrite, 'blocked write');
    await insert(' newer edit');
    writeGate.resolve();
    await until(
      () => !document.querySelector<HTMLButtonElement>('button[title="保存 (Ctrl+S)"]')?.disabled,
      'save complete',
    );
    await until(dirty, 'newer input remains dirty');
    check(
      !writes[0].includes('newer edit') && text().includes('newer edit'),
      'F01: pending write replaced newer input',
    );
    close();
    await until(() => document.querySelector('[role="dialog"]'), 'newer input close warning');
  } else if (imageCase) {
    const sourceText = () =>
      document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')
        ?.value;
    const enteringSource = testCase === 'image-save-enter-source';
    const switchingTab = testCase === 'image-save-switch' || testCase === 'image-saveas-switch';
    if (!enteringSource) {
      source();
      await until(
        () => sourceText() === files.get('C:/notes/a.md')!.content,
        'original image source preserved',
      );
    }
    holdWrite = true;
    if (testCase === 'image-saveas-switch') click('button[title="另存为"]');
    else save();
    await until(() => awaitingWrite, 'blocked image write');
    check(!writes[0].includes('mdplus-image:'), 'Image migration did not rewrite the placeholder');
    check(
      writes[0].includes('![photo](') && writes[0].includes('caption'),
      'Image migration lost the reference or title',
    );
    const expectedPath = testCase === 'image-saveas-switch' ? 'C:/export/a.md' : 'C:/notes/a.md';
    check(writePaths[0] === expectedPath, 'Image save targeted the wrong document');
    if (switchingTab) {
      click('button[title="打开 (Ctrl+O)"]');
      await until(() => text().includes('other document'), 'second document');
      source();
      await until(() => sourceText()?.includes('other document'), 'second source');
    } else if (enteringSource) {
      source();
      await until(
        () => sourceText() === files.get('C:/notes/a.md')!.content,
        'original source opened during save',
      );
    }
    writeGate.resolve();
    await until(() => files.get(expectedPath)?.content === writes[0], 'image write completed');
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (switchingTab) {
      check(sourceText() === 'other document\n', 'Image save replaced the other tab source view');
      check(
        files.get('C:/notes/b.md')?.content === 'other document\n',
        'Image save overwrote the other file',
      );
      const firstTab = document.querySelector<HTMLButtonElement>('[role="tab"]');
      check(firstTab, 'Saved tab disappeared');
      firstTab.click();
      await until(() => sourceText()?.includes('document A'), 'saved document source');
    }
    check(sourceText() === writes[0], 'Image save left the current source view stale');
    check(!dirty(), 'Completed image save left an unchanged document dirty');
  } else {
    holdConfirmation = testCase === 'edit-during-confirm';
    holdRead = [
      'edit-during-read',
      'close-during-read',
      'switch-during-read',
      'source-during-read',
      'render-during-read',
      'disk-during-read',
    ].includes(testCase);
    holdMtime = testCase === 'edit-during-mtime';
    if (testCase === 'switch-during-read' || testCase === 'render-during-read') {
      source();
      await until(
        () => document.querySelector('.source-editor:not([hidden]) .source-textarea'),
        'initial source mode',
      );
    }
    files.set('C:/notes/a.md', { content: 'disk replacement\n', mtime: 200 });
    await until(() => confirms > 0, 'external reload confirmation');
    if (holdRead) await until(() => awaitingRead, 'blocked reload read');
    if (holdMtime) await until(() => awaitingMtime, 'blocked reload metadata');
    if (testCase === 'close-during-read') {
      close();
      await until(() => !document.querySelector('[role="tab"]'), 'tab closed');
      readGate.resolve();
      await until(() => completedRead, 'released reload');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      check(!document.querySelector('[role="tab"]'), 'F03: reload resurrected a closed tab');
    } else if (testCase === 'switch-during-read') {
      click('button[title="打开 (Ctrl+O)"]');
      await until(() => text().includes('other document'), 'second document');
      source();
      await until(
        () =>
          document
            .querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')
            ?.value.includes('other document'),
        'second source',
      );
      readGate.resolve();
      await until(
        () => host.textContent?.includes('disk replacement'),
        'background reload complete',
      );
      check(
        document
          .querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')
          ?.value.includes('other document'),
        'F03: reload replaced the other tab source view',
      );
    } else if (testCase === 'disk-during-read') {
      files.set('C:/notes/a.md', { content: 'newer disk replacement\n', mtime: 300 });
      readGate.resolve();
      await until(
        () => messages.length > 1 || text().includes('disk replacement'),
        'disk changed during read',
      );
      check(text().includes('original'), 'F03: an old disk read was accepted with a newer mtime');
      check(writes.length === 0, 'F03: inconsistent read was saved');
    } else if (testCase === 'source-during-read') {
      source();
      await until(
        () => document.querySelector('.source-editor:not([hidden]) .source-textarea'),
        'switch to source during read',
      );
      readGate.resolve();
      await until(() => host.textContent?.includes('disk replacement'), 'reload committed');
      check(
        document
          .querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')
          ?.value.includes('disk replacement'),
        'F03: newly active source view kept stale content',
      );
    } else if (testCase === 'render-during-read') {
      source();
      await until(
        () => !document.querySelector('.source-editor:not([hidden]) .source-textarea'),
        'switch to rendered mode during read',
      );
      readGate.resolve();
      await until(
        () => text().includes('disk replacement'),
        'reload after switching to rendered mode',
      );
      check(!dirty(), 'F03: switching presentation invalidated an unchanged document');
    } else if (testCase === 'reload-clean') {
      await until(() => text().includes('disk replacement'), 'clean reload');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      check(!dirty(), 'F03: clean reload became dirty');
    } else {
      await insert(' newer local input');
      confirmation.resolve('Yes');
      readGate.resolve();
      mtimeGate.resolve();
      // App must either report a canceled reload or finish the old (defective) replacement.
      await until(
        () => messages.length > 1 || text().includes('disk replacement'),
        'reload resolution',
      );
      check(text().includes('newer local input'), `F03: ${testCase} overwrote local input`);
      await until(dirty, 'retained input remains dirty');
      check(writes.length === 0, 'F03: stale reload triggered an unrequested write');
    }
  }
  check(destroyed === 0, 'Unexpected native window destruction');
  check(unexpected.length === 0, `Unmocked IPC calls: ${unexpected.join(', ')}`);
  return `${testCase}: passed (real React/Milkdown; simulated native IPC)`;
}
