import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import App from '../../src/App';
import { getImageUrls } from '../../src/lib/imagePaths';

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
  const imageCase = testCase.startsWith('image-save');
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
  const store = new Map<string, unknown>();
  const writes: string[] = [];
  const binaries = new Map<string, number[]>();
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
      case 'cache_recovery_image':
      case 'write_recovery_snapshot':
      case 'delete_recovery_snapshot': return;
      case 'take_startup_files': return ['C:/notes/a.md'];
      case 'take_pending_open_files': return [];
      case 'plugin:store|load': return 1;
      case 'plugin:store|get': return [store.get(String(args.key)), store.has(String(args.key))];
      case 'plugin:store|set': store.set(String(args.key), args.value); return;
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
      case 'plugin:dialog|save': return testCase === 'image-saveas-switch' ? 'C:/export/a.md' : 'C:/notes/a.md';
      case 'plugin:path|dirname': return String(args.path).replace(/\/[^/]+$/, '');
      case 'plugin:path|join': return (args.paths as string[]).join('/').replace('/./', '/');
      case 'read_image_file': {
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
      case 'plugin:dialog|message': {
        const message = String(args.message);
        messages.push(message);
        if (message.includes('重新加载文件')) {
          confirms += 1;
          return holdConfirmation ? confirmation.promise : 'Yes';
        }
        return args.buttons === 'YesNo' ? 'No' : 'Ok';
      }
      case 'read_file': {
        const file = files.get(String(args.path));
        check(file, `Unknown file: ${args.path}`);
        const content = file.content;
        if (holdRead && args.path === 'C:/notes/a.md') {
          awaitingRead = true;
          await readGate.promise;
          completedRead = true;
        }
        if (confirms > 0) didReloadRead = true;
        return content;
      }
      case 'file_mtime': {
        if (binaries.has(String(args.path))) return 100;
        const file = files.get(String(args.path));
        check(file, `Unknown file: ${args.path}`);
        if (holdMtime && didReloadRead && args.path === 'C:/notes/a.md') {
          awaitingMtime = true;
          await mtimeGate.promise;
        }
        return file.mtime;
      }
      case 'write_file': {
        writes.push(String(args.content));
        writePaths.push(String(args.path));
        if (failWrite) { failWrite = false; throw new Error('simulated disk write failure'); }
        if (holdWrite) { awaitingWrite = true; await writeGate.promise; }
        const file = files.get(String(args.path));
        check(file, `Unknown write: ${args.path}`);
        file.content = String(args.content);
        file.mtime += 1;
        return;
      }
      default:
        unexpected.push(command);
        throw new Error(`Unmocked IPC: ${command}`);
    }
  }, { shouldMockEvents: true });

  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(<App />);
  await until(() => document.querySelector('.editor-tab.active .ProseMirror'), 'ready editor');
  // Wait for EditorTab's initial-state effect, not Milkdown's former content debounce.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const save = () => click('button[title^="保存 (Ctrl+S)"]');
  const close = () => click('.tab.active .tab-close');
  const source = () => click('button[title*="源码"]');
  const dirty = () => document.querySelector('.tab.active .tab-dot')?.getAttribute('data-dirty') === '1';

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
      await until(() => sourceText()?.includes('mdplus-image:'), 'hydrated image source');
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
      await until(() => sourceText()?.includes('mdplus-image:'), 'source opened during save');
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
