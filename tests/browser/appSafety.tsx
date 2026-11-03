import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import App from '../../src/App';
import { getImageUrls } from '../../src/lib/imagePaths';
import { getThemeMode } from '../../src/lib/store';

// Real App, React and Milkdown. Only the native IPC boundary is simulated.
// Run one case per page load to isolate module-level stores and browser timers.
export const safetyCases = [
  'save-immediately', 'close-immediately', 'source-immediately', 'edit-during-save',
  'reload-clean', 'edit-during-confirm', 'edit-during-read', 'edit-during-mtime',
  'close-during-read', 'switch-during-read', 'source-during-read', 'render-during-read', 'disk-during-read',
  'image-save-stay', 'image-save-switch', 'image-saveas-switch', 'image-save-enter-source',
  'source-images-new', 'source-images-existing', 'source-images-toggle', 'source-images-save-failure',
  'edit-during-window-close',
  'source-save-selection', 'source-autosave-selection', 'rendered-save-selection', 'background-save-focus',
  'source-save-wrapped-reference',
  'theme-preference-startup',
  'no-edit-reference-links', 'no-edit-bare-autolinks',
  'image-reference-source', 'image-reference-reload', 'image-reference-refresh', 'image-reference-saveas-edit', 'image-reference-saveas-undo', 'image-reference-recovery',
  'save-paused-feedback', 'drop-unsupported-feedback', 'drop-mixed-feedback', 'file-identity-feedback', 'print-action-label',
] as const;
export type SafetyCase = typeof safetyCases[number];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
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
  const files = new Map([
    ['C:/notes/a.md', { content: 'original\n', mtime: 100 }],
    ['C:/notes/b.md', { content: 'other document\n', mtime: 100 }],
  ]);
  const noEditRaw = testCase === 'no-edit-reference-links'
    ? "[Full][id] [collapsed][] [shortcut]\n\n[id]: https://example.com/full \"title\"\n[collapsed]: https://example.com/collapsed\n[shortcut]: https://example.com/shortcut\n"
    : testCase === 'no-edit-bare-autolinks'
      ? "Visit https://example.com/path?q=1&x=2. Email audit@example.com.\n" : null;
  if (noEditRaw !== null) files.set('C:/notes/a.md', { content: noEditRaw, mtime: 100 });
  const imageCase = testCase.startsWith('image-save');
  const imageReferenceCase = testCase.startsWith('image-reference-');
  const continuityCase = ['source-save-selection', 'source-autosave-selection', 'rendered-save-selection', 'background-save-focus', 'source-save-wrapped-reference'].includes(testCase);
  const sourceImageCase = testCase.startsWith('source-images-');
  if (sourceImageCase) files.set('C:/notes/a.md', { content: '', mtime: 100 });
  if (imageCase) files.set('C:/notes/a.md', {
    content: 'document A\n\n![photo](./img/pic.png "caption")\n', mtime: 100,
  });
  if (continuityCase) files.set('C:/notes/a.md', {
    content: `![photo](./img/pic.png)\n\n${Array.from({ length: 50 }, (_, i) => `## Heading ${i}\n\n段落 ${i} mixed content ${'text '.repeat(30)}\n`).join('\n')}\n![photo](./img/last.png)\n`,
    mtime: 100,
  });
  if (testCase === 'source-save-wrapped-reference') {
    const file = files.get('C:/notes/a.md')!;
    file.content = file.content.replace('./img/pic.png', `<./img/${'中文 深层目录/'.repeat(18)}photo.png>`);
  }
  files.set('C:/export/a.md', { content: '', mtime: 100 });
  const themeStartupCase = testCase === 'theme-preference-startup';
  const store = new Map<string, unknown>(themeStartupCase ? [['theme-mode', 'dark']] : []);
  const themeOperations: string[] = [];
  const writes: string[] = [];
  const binaries = new Map<string, number[]>();
  const recoveryImageBytes = new Map<string, number[]>();
  const recoverySnapshots: { markdown: string; images: { key: string; placeholder: string }[] }[] = [];
  const imageReadGate = deferred<void>();
  let awaitingImageRead = false;
  let holdImageRead = testCase === 'image-reference-recovery';
  let expectedReferenceImage: number[] = [];
  let expectedReferenceSource = '';
  if (imageReferenceCase) {
    const image = (color: string) => {
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
      const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, 2, 2);
      const source = canvas.toDataURL('image/png');
      return { source, bytes: Array.from(atob(source.split(',')[1]), (char) => char.charCodeAt(0)) };
    };
    const oldImage = image('#c0392b'); const newImage = image('#2471a3');
    const expectedImage = testCase === 'image-reference-saveas-edit' || testCase === 'image-reference-saveas-undo' ? oldImage : newImage;
    expectedReferenceImage = expectedImage.bytes; expectedReferenceSource = expectedImage.source;
    binaries.set('C:/notes/img/pic.png', oldImage.bytes);
    binaries.set('C:/notes/img/next.png', newImage.bytes);
    files.set('C:/notes/a.md', { content: testCase === 'image-reference-source' || testCase === 'image-reference-recovery' ? '# Reference\n' : '# Reference\n\n![](./img/pic.png)\n', mtime: 100 });
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
  let completedRead = false;
  let destroyed = 0;
  const windowStateGate = deferred<void>();
  let holdWindowState = false;
  let awaitingWindowState = false;
  let openPath = 'C:/notes/b.md';
  let failWrite = testCase === 'source-images-save-failure';

  mockWindows('main');
  Object.assign(globalThis, { isTauri: true });
  mockIPC(async (command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (command) {
      case 'list_recovery_snapshots': return [];
      case 'cache_recovery_image': recoveryImageBytes.set(String(args.key), args.data as number[]); return;
      case 'write_recovery_snapshot': recoverySnapshots.push(args.snapshot as typeof recoverySnapshots[number]); return;
      case 'delete_recovery_snapshot': return;
      case 'take_startup_files': return ['C:/notes/a.md'];
      case 'take_pending_open_files': return [];
      case 'plugin:store|load': return 1;
      case 'plugin:store|get':
        if (args.key === 'theme-mode') themeOperations.push('get');
        return [store.get(String(args.key)), store.has(String(args.key))];
      case 'plugin:store|set':
        if (args.key === 'theme-mode') themeOperations.push('set');
        store.set(String(args.key), args.value); return;
      case 'plugin:store|save': return;
      case 'plugin:window|is_minimized': return false;
      case 'plugin:window|is_maximized': return false;
      case 'plugin:window|inner_size':
        if (holdWindowState) { awaitingWindowState = true; await windowStateGate.promise; }
        return { width: 1000, height: 700 };
      case 'plugin:window|outer_position': return { x: 0, y: 0 };
      case 'plugin:window|available_monitors': return [];
      case 'plugin:window|show':
      case 'plugin:window|set_focus': return;
      case 'plugin:window|destroy': destroyed += 1; return;
      case 'plugin:dialog|open': return openPath;
      case 'plugin:dialog|save':
        if (imageReferenceCase && (args.options as { title?: string } | undefined)?.title === '导出 HTML') return 'C:/export/result.html';
        return testCase === 'image-saveas-switch' || imageReferenceCase || testCase === 'save-paused-feedback' ? 'C:/export/a.md' : 'C:/notes/a.md';
      case 'plugin:path|dirname': return String(args.path).replace(/\/[^/]+$/, '');
      case 'plugin:path|join': return (args.paths as string[]).join('/').replace('/./', '/');
      case 'read_image_file': {
        if (imageReferenceCase) {
          const path = String(args.docPath).replace(/\/[^/]+$/, '') + '/' + String(args.relativePath);
          const data = binaries.get(path);
          check(data, `Missing referenced image ${path}`);
          if (holdImageRead) { awaitingImageRead = true; await imageReadGate.promise; }
          return { path, mime: 'image/png', data };
        }
        if (!sourceImageCase) return {
          path: continuityCase ? `C:/notes/${args.relativePath}` : 'C:/notes/img/pic.png',
          mime: 'image/png', data: [65, 66, 67],
        };
        const path = `C:/notes/${args.relativePath}`;
        check(binaries.has(path), `Image was not saved: ${path}`);
        return { path, mime: 'image/png', data: binaries.get(path) };
      }
      case 'create_directory': return;
      case 'save_binary_file': binaries.set(String(args.path), args.data as number[]); return;
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
          return holdConfirmation ? confirmation.promise : 'Yes';
        }
        if (message.includes('已存在。是否用当前文档替换') || (imageReferenceCase && message.includes('将导出可离线'))) return 'Yes';
        return args.buttons === 'YesNo' ? 'No' : 'Ok';
      }
      case 'read_file':
      case 'read_document': {
        const file = files.get(String(args.path));
        check(file, `Unknown file: ${args.path}`);
        // The native snapshot binds content and revision before an asynchronous caller resumes.
        const snapshot = { content: file.content, revision: `mock:${file.content}`, mtime: file.mtime };
        if (holdRead && args.path === 'C:/notes/a.md') {
          awaitingRead = true;
          await readGate.promise;
          completedRead = true;
        }
        if (confirms > 0) didReloadRead = true;
        return command === 'read_document' ? snapshot : snapshot.content;
      }
      case 'file_mtime':
      case 'document_revision': {
        if (command === 'file_mtime' && binaries.has(String(args.path))) return 100;
        if (holdMtime && didReloadRead && args.path === 'C:/notes/a.md') {
          awaitingMtime = true;
          await mtimeGate.promise;
        }
        const file = files.get(String(args.path));
        if (command === 'document_revision') return file
          ? { revision: `mock:${file.content}`, mtime: file.mtime } : { revision: null, mtime: null };
        check(file, `Unknown file: ${args.path}`);
        return file.mtime;
      }
      case 'write_file':
      case 'write_document': {
        if (imageReferenceCase && command === 'write_file') check(args.path === 'C:/export/result.html', 'HTML export must not overwrite the Markdown fixture');
        writes.push(String(args.content));
        writePaths.push(String(args.path));
        if (failWrite) { failWrite = false; throw new Error('simulated disk write failure'); }
        if (holdWrite) { awaitingWrite = true; await writeGate.promise; }
        const file = files.get(String(args.path));
        if (command === 'write_document' && args.expectedRevision !== (file ? `mock:${file.content}` : null)) {
          throw { code: 'CONFLICT', message: 'simulated revision conflict', path: String(args.path),
            recoveryPath: null, backupPath: null, actualRevision: file ? `mock:${file.content}` : null, writeState: 'unchanged' };
        }
        const saved = { content: String(args.content), mtime: (file?.mtime ?? 99) + 1 };
        files.set(String(args.path), saved);
        return command === 'write_document' ? { revision: `mock:${saved.content}`, mtime: saved.mtime, backupPath: null } : undefined;
      }
      default:
        unexpected.push(command);
        throw new Error(`Unmocked IPC: ${command}`);
    }
  }, { shouldMockEvents: true });

  if (themeStartupCase) {
    await getThemeMode(); // A ready native store exposes layout/passive effect ordering.
    themeOperations.length = 0;
  }
  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(<App />);
  await until(() => document.querySelector('.editor-tab.active .ProseMirror'), 'ready editor');
  // Wait for EditorTab's initial-state effect, not Milkdown's former content debounce.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (themeStartupCase) {
    check(themeOperations[0] === 'get', 'Initial layout overwrote the saved theme before reading it');
    await until(() => document.documentElement.dataset.theme === 'dark' && store.get('theme-mode') === 'dark', 'saved dark theme');
    click('button[aria-label="切换主题,当前为深色"]');
    await until(() => store.get('theme-mode') === 'system', 'explicit system theme persisted');
    check(document.documentElement.dataset.theme === (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      'Stored system choice did not resolve to the system appearance');
    return `${testCase}: saved dark preference survives startup; explicit choice still persists`;
  }
  const save = () => click('button[title^="保存 (Ctrl+S)"]');
  const close = () => click('.tab.active .tab-close');
  const source = () => click('button[title*="源码"]');
  const dirty = () => document.querySelector('.tab.active .tab-dot')?.getAttribute('data-dirty') === '1';

  if (testCase === 'save-paused-feedback') {
    await insert(' local draft');
    files.set('C:/notes/a.md', { content: 'external edit\n', mtime: 200 });
    await until(() => messages.some((message) => message.includes('自动保存已暂停')), 'automatic conflict notice');
    await until(() => !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled, 'paused save settled');
    check(document.querySelector('.status-save')?.textContent?.includes('自动保存已暂停'), 'Persistent pause status is missing');
    const noticesBeforeSave = messages.length;
    save();
    await until(() => messages.length > noticesBeforeSave, 'manual overwrite confirmation');
    await until(() => document.querySelector('.status-save')?.textContent === '自动保存已暂停'
      && !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled, 'manual conflict cancellation');
    check(files.get('C:/notes/a.md')!.content === 'external edit\n', 'Cancelled conflict overwrote external bytes');
    check(document.querySelector('.status-save')?.textContent?.includes('自动保存已暂停'), 'Cancelling overwrite falsely resumed saving');
    click('button[title="另存为"]');
    await until(() => files.get('C:/export/a.md')!.content.includes('local draft') && document.querySelector('.status-save')?.textContent === '已保存', 'SaveAs resolves pause');
    check(files.get('C:/notes/a.md')!.content === 'external edit\n', 'SaveAs changed the original external document');
    return `${testCase}: persistent pause survives cancel; explicit SaveAs preserves both documents`;
  }
  if (testCase === 'drop-unsupported-feedback' || testCase === 'drop-mixed-feedback') {
    const mixed = testCase === 'drop-mixed-feedback';
    await emit('tauri://drag-drop', { paths: [...(mixed ? ['C:/notes/b.md'] : []), 'C:/notes/unsupported.txt'], position: { x: 1, y: 1 } });
    await until(() => messages.some((message) => message.includes('已忽略 1')), 'unsupported dropped-file notice');
    if (mixed) await until(() => text().includes('other document'), 'supported part of a mixed drop');
    check(document.querySelectorAll('[role="tab"]').length === (mixed ? 2 : 1), 'Drop opened an unsupported path or lost a supported document');
    check(unexpected.length === 0, 'Unsupported drop reached unexpected native IPC');
    return `${testCase}: unsupported paths reported without discarding supported Markdown`;
  }
  if (testCase === 'file-identity-feedback') {
    check(document.querySelector('.status-file-identity')?.textContent === 'C:/notes/a.md', 'Status omits full document identity');
    check(document.querySelector('[role="tab"]')?.getAttribute('aria-label')?.includes('C:/notes/a.md'), 'Tab accessible name cannot distinguish same-named files');
    return `${testCase}: current path is visible and accessible`;
  }
  if (testCase === 'print-action-label') {
    click('button[title="导出"]'); await until(() => document.querySelector('[role="menuitem"]'), 'export menu');
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent === '打印 / 另存为 PDF');
    check(item?.title.includes('确认保存'), 'Print action falsely implies an already saved PDF');
    return `${testCase}: print-to-PDF action requires explicit confirmation in the system dialog`;
  }

  if (testCase === 'image-reference-recovery') {
    holdWrite = true;
    source(); await until(() => document.querySelector('.source-editor:not([hidden]) textarea'), 'source editor');
    const field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
    const markdown = '# One edit\n\n![new](./img/next.png)\n';
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, markdown);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => awaitingImageRead, 'pending image read');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    check(recoverySnapshots.length === 0, 'Recovery persisted a relative-image draft before its bytes were prepared');
    check(document.querySelector('.recovery-status-pending'), 'Pending image bytes were advertised as protected or failed prematurely');
    holdImageRead = false; imageReadGate.resolve();
    await until(() => recoverySnapshots.some((snapshot) => snapshot.images.length === 1), 'portable recovery snapshot after one input');
    const snapshot = recoverySnapshots[recoverySnapshots.length - 1];
    check(snapshot.markdown.includes('mdplus-image:') && !snapshot.markdown.includes('./img/next.png'), 'Recovery retained an unusable relative image reference');
    check(JSON.stringify(recoveryImageBytes.get(snapshot.images[0].key)) === JSON.stringify(expectedReferenceImage), 'Recovery image bytes disagree with the prepared preview');
    check(field.value === markdown, 'Recovery changed the source draft');
    holdWrite = false; writeGate.resolve();
    return `${testCase}: a single raw-image edit waits for bytes before durable recovery protection`;
  }

  if (testCase === 'image-reference-saveas-edit' || testCase === 'image-reference-saveas-undo') {
    const undoEdit = testCase === 'image-reference-saveas-undo';
    await until(() => document.querySelector<HTMLImageElement>('.editor-tab.active .md-image-node img')?.naturalWidth, 'initial relative image');
    source(); await until(() => document.querySelector('.source-editor:not([hidden]) textarea'), 'source editor');
    const field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
    const original = field.value;
    holdWrite = true; click('button[title="另存为"]');
    await until(() => awaitingWrite, 'SaveAs pending write');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, original + '\nconcurrent edit');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    if (undoEdit) {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
      await until(() => field.value === original, 'source undo restores original Markdown');
    }
    const currentDraft = undoEdit ? original : original + '\nconcurrent edit';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    holdWrite = false; writeGate.resolve();
    await until(() => !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled, 'SaveAs and queued save settled');
    check(document.querySelector('.status-file-identity')?.textContent === 'C:/notes/a.md', 'Concurrent image SaveAs changed the relative-image base');
    check(field.value === currentDraft, 'Concurrent SaveAs changed the latest source');
    check(messages.some((message) => message.includes('副本已写入')), 'Written snapshot and retained current draft are not distinguished');
    check(writePaths.length === 1 && writePaths[0] === 'C:/export/a.md', 'Queued save wrote after a base-preserving cancellation');
    check(files.get('C:/notes/a.md')!.content === original, 'Original Markdown changed during SaveAs');
    click('button[title="另存为"]');
    await until(() => document.querySelector('.status-file-identity')?.textContent === 'C:/export/a.md' && !dirty(), 'explicit SaveAs retry');
    check(files.get('C:/export/a.md')!.content.includes('concurrent edit') === !undoEdit, 'SaveAs retry persisted text that had been undone');
    const url = getImageUrls(files.get('C:/export/a.md')!.content)[0];
    check(url?.startsWith('./assets/'), 'Retried SaveAs lost portable image path');
    check(JSON.stringify(binaries.get(`C:/export/${url.slice(2)}`)) === JSON.stringify(expectedReferenceImage), 'Retried SaveAs lost original image bytes');
    return `${testCase}: concurrent relative-image draft retains its base; retry preserves latest text and bytes`;
  }

  if (imageReferenceCase) {
    if (testCase === 'image-reference-source') {
      source(); await until(() => document.querySelector('.source-editor:not([hidden]) textarea'), 'source editor');
      const field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
      const markdown = '# Reference\n\n![](./img/next.png)\n';
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, markdown);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      source();
      await until(() => !document.querySelector('.source-editor:not([hidden])'), 'rendered reference');
      check(field.value === markdown, 'Resolving an image rewrote typed source');
    } else {
      await until(() => document.querySelector<HTMLImageElement>('.editor-tab.active .md-image-node img')?.naturalWidth, 'initial image');
      if (testCase === 'image-reference-refresh') binaries.set('C:/notes/img/pic.png', expectedReferenceImage);
      files.set('C:/notes/a.md', { content: testCase === 'image-reference-reload'
        ? '# External\n\n![](./img/pic.png)\n\n![](./img/next.png)\n' : '# External\n\n![](./img/pic.png)\n', mtime: 200 });
      await until(() => confirms > 0 && text().includes('External'), 'external document reload');
    }
    await until(() => Array.from(document.querySelectorAll<HTMLImageElement>('.editor-tab.active img'))
      .some((image) => image.src === expectedReferenceSource && image.naturalWidth > 0), 'current image bytes in preview');
    click('button[title="另存为"]');
    await until(() => files.get('C:/export/a.md')!.content.includes('./assets/'), 'portable SaveAs references');
    const portableMarkdown = files.get('C:/export/a.md')!.content;
    const references = getImageUrls(files.get('C:/export/a.md')!.content);
    const last = references[references.length - 1];
    check(last?.startsWith('./assets/'), 'SaveAs retained an unportable image path');
    check(JSON.stringify(binaries.get(`C:/export/${last.slice(2)}`)) === JSON.stringify(expectedReferenceImage), 'SaveAs copied stale or missing image bytes');
    click('button[title="导出"]');
    await until(() => document.querySelector('[role="menuitem"]'), 'export menu');
    const htmlButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent?.includes('HTML'));
    check(htmlButton, 'HTML export action missing'); htmlButton.click();
    await until(() => files.has('C:/export/result.html'), 'offline HTML output');
    check(files.get('C:/export/a.md')!.content === portableMarkdown, 'HTML export overwrote the current Markdown document');
    const exported = new DOMParser().parseFromString(files.get('C:/export/result.html')!.content, 'text/html');
    check(Array.from(exported.images).some((image) => image.getAttribute('src') === expectedReferenceSource), 'Offline export embedded stale or missing image bytes');
    check(unexpected.length === 0, 'Unexpected IPC in image reference flow');
    return `${testCase}: preview, SaveAs and offline HTML agree on current bytes (native IPC mocked)`;
  }

  if (noEditRaw !== null) {
    // Let the passive initial notification settle before testing a no-edit save.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    check(!dirty(), 'Opening the original source was marked as an edit');
    save();
    await until(() => writes.length > 0, 'no-edit save write');
    check(writes[0] === noEditRaw, `No-edit save rewrote original source: ${JSON.stringify({ expected: noEditRaw, actual: writes[0] })}`);
    await until(() => !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled, 'no-edit save complete');
    check(!dirty() && files.get('C:/notes/a.md')!.content === noEditRaw, 'No-edit save changed source or dirty state');
    source();
    await until(() => document.querySelector('.source-editor:not([hidden]) textarea'), 'original source readback');
    check(document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!.value === noEditRaw, 'Source view lost original spelling');
    source();
    await until(() => !document.querySelector('.source-editor:not([hidden]) textarea'), 'return to rendered mode without editing');
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
      await until(() => document.querySelector('.source-editor:not([hidden]) textarea'), 'source editor');
      const field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
      const extra = ' draft edit';
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, field.value + extra);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const at = field.value.indexOf('段落 25');
      field.focus(); field.setSelectionRange(at, at + 5, 'backward'); field.scrollTop = 1400;
      const selected = field.value.slice(at, at + 5);
      const top = field.scrollTop;
      const height = field.scrollHeight;
      field.dispatchEvent(new Event('select', { bubbles: true }));
      field.dispatchEvent(new Event('scroll', { bubbles: true }));
      if (testCase !== 'source-autosave-selection') save();
      await until(() => writes.length > 0 && !dirty(), 'image references saved');
      check(field.value.slice(field.selectionStart, field.selectionEnd) === selected,
        `Image migration displaced the selected source text: ${JSON.stringify({ selected, actual: field.value.slice(field.selectionStart, field.selectionEnd), at: field.selectionStart, expected: field.value.indexOf(selected), sourceAt: at })}`);
      const expectedTop = testCase === 'source-save-wrapped-reference' ? top + field.scrollHeight - height : top;
      check(field.selectionDirection === 'backward' && Math.abs(field.scrollTop - expectedTop) <= 1, 'Image migration moved source viewport or direction');
      check(document.activeElement === field, 'Save took focus from source');
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
      await until(() => !field.value.endsWith(extra), 'source undo survived migration');
      check(!field.value.includes('mdplus-image:'), 'Undo resurrected stale image placeholders');
    } else {
      const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
      const scroller = document.querySelector<HTMLElement>('.editor-tab.active .milkdown-container')!;
      const paragraph = Array.from(editor.querySelectorAll('p')).find((p) => p.textContent?.startsWith('段落 25'))!;
      editor.focus();
      const range = document.createRange(); range.setStart(paragraph.firstChild!, 0); range.setEnd(paragraph.firstChild!, 5);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      check(window.getSelection()?.toString() === '段落 25', 'Fixture did not establish rendered text selection');
      scroller.scrollTop = 1700;
      const top = scroller.scrollTop;
      holdWrite = testCase === 'background-save-focus';
      save();
      if (holdWrite) {
        await until(() => awaitingWrite, 'blocked background write');
        click('button[title="打开 (Ctrl+O)"]');
        await until(() => text().includes('other document'), 'other tab opened');
        source();
        await until(() => document.querySelector('.source-editor:not([hidden]) textarea'), 'other source');
        const other = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
        other.focus();
        writeGate.resolve();
        await until(() => !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled, 'background save complete');
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        check(document.activeElement === other, 'Background image save stole the other tab focus');
        click('[role="tab"]');
        await until(() => document.querySelector('.editor-tab.active .ProseMirror')?.contains(paragraph), 'original tab restored');
        check(scroller.scrollTop === top, 'Background image save lost the saved viewport');
      } else {
        await until(() => writes.length > 0 && !dirty(), 'rendered image save complete');
        check(window.getSelection()?.toString() === '段落 25', 'Image migration lost rendered text selection');
        check(scroller.scrollTop === top && document.activeElement === editor,
          `Image migration jumped or stole focus: top ${scroller.scrollTop} expected ${top}, focus ${document.activeElement?.className}`);
      }
    }
  } else if (testCase === 'edit-during-window-close') {
    holdWindowState = true;
    click('button[aria-label="关闭窗口"]');
    await until(() => awaitingWindowState, 'pending close metadata');
    await insert(' input while closing');
    windowStateGate.resolve();
    await until(() => document.querySelector('#close-document-title') || destroyed > 0, 'close outcome');
    check(destroyed === 0 && text().includes('input while closing'), 'Window close lost input made during metadata persistence');
  } else if (sourceImageCase) {
    if (testCase === 'source-images-new') {
      close();
      await until(() => !document.querySelector('[role="tab"]'), 'close initial document');
      click('button[title="新建文档 (Ctrl+N)"]');
      await until(() => document.querySelector('.newfile-card'), 'new document dialog');
      click('.newfile-card');
      await until(() => document.querySelector('.editor-tab.active .ProseMirror'), 'new editor');
    }
    const labels = Array.from(document.querySelectorAll('.toolbar-file-actions .toolbar-btn-label'),
      (element) => element.textContent);
    check(labels.filter((label) => label === '保存').length === 1
      && labels.filter((label) => label === '另存为').length === 1, 'Duplicate Save As labels');
    source();
    await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'), 'source editor');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const field = () => document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')!;
    const pixel = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
    for (let i = 0; i < 4; i++) {
      const input = field();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([pixel], `pasted-${i}.png`, { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      await until(() => getImageUrls(field().value).length === i + 1, 'pasted image reference');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const draft = field().value;
    const renderedImages = () => Array.from(document.querySelectorAll<HTMLImageElement>(
      '.editor-tab.active .ProseMirror img:not(.ProseMirror-separator)'));
    if (testCase === 'source-images-toggle') {
      source();
      await until(() => !document.querySelector('.source-editor:not([hidden]) .source-textarea'), 'leave source before save');
      await until(() => renderedImages().length === 4, 'four rendered images before save');
    }
    save();
    if (testCase === 'source-images-save-failure') {
      await until(() => messages.some((message) => message.includes('simulated disk write failure')), 'save error');
      check(field().value === draft, 'Failed save replaced the source draft');
      await until(dirty, 'failed save remains unsaved');
      await until(() => !document.querySelector<HTMLButtonElement>('button[title^="保存 (Ctrl+S)"]')!.disabled, 'retry enabled');
      save();
    }
    await until(() => getImageUrls(files.get('C:/notes/a.md')!.content).length === 4, 'four saved image references');
    await until(() => !dirty(), 'save completion');
    const saved = files.get('C:/notes/a.md')!.content;
    check(!saved.includes('mdplus-image:'), 'Saved Markdown contains temporary image tokens');
    for (const url of getImageUrls(saved)) {
      check(binaries.get(`C:/notes/${url.replace(/^\.\//, '')}`)?.length === pixel.length, 'Saved image bytes are missing');
    }
    if (document.querySelector('.source-editor:not([hidden]) .source-textarea')) source();
    await until(() => renderedImages().length === 4 && renderedImages().every((image) => image.naturalWidth > 0), 'four loaded previews');
    source();
    await until(() => getImageUrls(field()?.value ?? '').length === 4, 'images after mode round trip');
    close();
    await until(() => !document.querySelector('[role="tab"]'), 'close saved document');
    openPath = 'C:/notes/a.md';
    click('button[title="打开 (Ctrl+O)"]');
    await until(() => renderedImages().length === 4 && renderedImages().every((image) => image.naturalWidth > 0), 'four images after reopen');
    check(files.get('C:/notes/a.md')!.content === saved, 'Reopening rewrote the saved document');
  } else if (testCase === 'save-immediately') {
    await insert(' last character'); save();
    await until(() => writes.length > 0, 'save call');
    check(writes[0].includes('last character'), 'F01: immediate save lost the last input');
  } else if (testCase === 'close-immediately') {
    await insert(' last character'); close();
    await until(() => document.querySelector('[role="dialog"]') || !document.querySelector('[role="tab"]'), 'close outcome');
    check(document.querySelector('[role="dialog"]'), 'F01: immediate close skipped unsaved confirmation');
    check(document.querySelector('[role="tab"]'), 'F01: unsaved tab was removed');
  } else if (testCase === 'source-immediately') {
    await insert(' last character'); source();
    await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'), 'source editor');
    check(document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')?.value.includes('last character'), 'F01: source switch lost the last input');
  } else if (testCase === 'edit-during-save') {
    holdWrite = true;
    await insert(' saved edit'); save();
    await until(() => awaitingWrite, 'blocked write');
    await insert(' newer edit'); writeGate.resolve();
    await until(() => !document.querySelector<HTMLButtonElement>('button[title="保存 (Ctrl+S)"]')?.disabled, 'save complete');
    await until(dirty, 'newer input remains dirty');
    check(!writes[0].includes('newer edit') && text().includes('newer edit'), 'F01: pending write replaced newer input');
    close();
    await until(() => document.querySelector('[role="dialog"]'), 'newer input close warning');
  } else if (imageCase) {
    const sourceText = () => document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')?.value;
    const enteringSource = testCase === 'image-save-enter-source';
    const switchingTab = testCase === 'image-save-switch' || testCase === 'image-saveas-switch';
    if (!enteringSource) {
      source();
      await until(() => sourceText() === files.get('C:/notes/a.md')!.content, 'original image source preserved');
    }
    holdWrite = true;
    if (testCase === 'image-saveas-switch') click('button[title="另存为"]');
    else save();
    await until(() => awaitingWrite, 'blocked image write');
    check(!writes[0].includes('mdplus-image:'), 'Image migration did not rewrite the placeholder');
    check(writes[0].includes('![photo](') && writes[0].includes('caption'), 'Image migration lost the reference or title');
    const expectedPath = testCase === 'image-saveas-switch' ? 'C:/export/a.md' : 'C:/notes/a.md';
    check(writePaths[0] === expectedPath, 'Image save targeted the wrong document');
    if (switchingTab) {
      click('button[title="打开 (Ctrl+O)"]');
      await until(() => text().includes('other document'), 'second document');
      source();
      await until(() => sourceText()?.includes('other document'), 'second source');
    } else if (enteringSource) {
      source();
      await until(() => sourceText() === files.get('C:/notes/a.md')!.content, 'original source opened during save');
    }
    writeGate.resolve();
    await until(() => files.get(expectedPath)?.content === writes[0], 'image write completed');
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (switchingTab) {
      check(sourceText() === 'other document\n', 'Image save replaced the other tab source view');
      check(files.get('C:/notes/b.md')?.content === 'other document\n', 'Image save overwrote the other file');
      const firstTab = document.querySelector<HTMLButtonElement>('[role="tab"]');
      check(firstTab, 'Saved tab disappeared');
      firstTab.click();
      await until(() => sourceText()?.includes('document A'), 'saved document source');
    }
    check(sourceText() === writes[0], 'Image save left the current source view stale');
    check(!dirty(), 'Completed image save left an unchanged document dirty');
  } else {
    holdConfirmation = testCase === 'edit-during-confirm';
    holdRead = ['edit-during-read', 'close-during-read', 'switch-during-read', 'source-during-read', 'render-during-read', 'disk-during-read'].includes(testCase);
    holdMtime = testCase === 'edit-during-mtime';
    if (testCase === 'switch-during-read' || testCase === 'render-during-read') {
      source();
      await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'), 'initial source mode');
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
      await until(() => document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')?.value.includes('other document'), 'second source');
      readGate.resolve();
      await until(() => host.textContent?.includes('disk replacement'), 'background reload complete');
      check(document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')?.value.includes('other document'), 'F03: reload replaced the other tab source view');
    } else if (testCase === 'disk-during-read') {
      files.set('C:/notes/a.md', { content: 'newer disk replacement\n', mtime: 300 });
      readGate.resolve();
      await until(() => messages.length > 1 || text().includes('disk replacement'), 'disk changed during read');
      check(text().includes('original'), 'F03: an old disk read was accepted with a newer mtime');
      check(writes.length === 0, 'F03: inconsistent read was saved');
    } else if (testCase === 'source-during-read') {
      source();
      await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'), 'switch to source during read');
      readGate.resolve();
      await until(() => host.textContent?.includes('disk replacement'), 'reload committed');
      check(document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')?.value.includes('disk replacement'), 'F03: newly active source view kept stale content');
    } else if (testCase === 'render-during-read') {
      source();
      await until(() => !document.querySelector('.source-editor:not([hidden]) .source-textarea'), 'switch to rendered mode during read');
      readGate.resolve();
      await until(() => text().includes('disk replacement'), 'reload after switching to rendered mode');
      check(!dirty(), 'F03: switching presentation invalidated an unchanged document');
    } else if (testCase === 'reload-clean') {
      await until(() => text().includes('disk replacement'), 'clean reload');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      check(!dirty(), 'F03: clean reload became dirty');
    } else {
      await insert(' newer local input');
      confirmation.resolve('Yes'); readGate.resolve(); mtimeGate.resolve();
      // App must either report a canceled reload or finish the old (defective) replacement.
      await until(() => messages.length > 1 || text().includes('disk replacement'), 'reload resolution');
      check(text().includes('newer local input'), `F03: ${testCase} overwrote local input`);
      await until(dirty, 'retained input remains dirty');
      check(writes.length === 0, 'F03: stale reload triggered an unrequested write');
    }
  }
  check(destroyed === 0, 'Unexpected native window destruction');
  check(unexpected.length === 0, `Unmocked IPC calls: ${unexpected.join(', ')}`);
  return `${testCase}: passed (real React/Milkdown; simulated native IPC)`;
}
