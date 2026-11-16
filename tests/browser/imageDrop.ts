import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { emit } from '@tauri-apps/api/event';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/prose/state';
import {
  createEditor,
  getCurrentState,
  getEditorImageReferences,
  insertImageBatchAt,
  trackEditorPosition,
  undo,
  redo,
} from '../../src/lib/editor';
import {
  clearPendingImages,
  getPendingImages,
  registerImageReachability,
  resolveImageSource,
} from '../../src/lib/imageOps';
import { getImageUrls } from '../../src/lib/imagePaths';
import { runImageDrop, sourceOffsetAtPoint, type DropPosition } from '../../src/lib/imageDrop';
import { getSourceEditorApi, type SourceEditorApi } from '../../src/lib/sourceEditorApi';
import App from '../../src/App';
import { createNativeMocks, decodeFixtureBase64 } from './nativeMocks';

export const imageDropCases = [
  'image-drop-source-wrapped-position',
  'image-drop-source-batch-history',
  'image-drop-rendered-batch-history',
  'image-drop-rendered-code-position',
  'image-drop-rendered-native-position',
  'image-drop-rendered-tab-switch',
  'image-drop-source-tab-switch',
  'image-drop-close-during-read',
  'image-drop-mode-during-read',
  'image-drop-mode-roundtrip-during-read',
  'image-drop-partial-failure',
  'image-drop-draft-save-assets',
  'image-picker-source-history',
  'image-picker-rich-history',
  'image-picker-dialog-cancel',
  'image-picker-dialog-tab-switch',
  'image-drop-progress',
  'image-picker-progress',
] as const;
export type ImageDropCase = (typeof imageDropCases)[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Image drop: ${message}`);
}
async function until(condition: () => unknown, message: string) {
  const deadline = performance.now() + 12000;
  while (!condition()) {
    check(performance.now() < deadline, `timed out: ${message}`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
function click(selector: string) {
  const button = document.querySelector<HTMLElement>(selector);
  check(button, `missing ${selector}`);
  button.click();
}
function nativeInput(input: HTMLTextAreaElement, text: string, caret = text.length) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}
function activeSource() {
  return document.querySelector<HTMLTextAreaElement>(
    '.source-editor:not([hidden]) .source-textarea',
  );
}
function sourceApi(input: HTMLTextAreaElement): SourceEditorApi {
  const api = getSourceEditorApi(input);
  check(api, 'source bridge is not registered');
  return api;
}
function physical(point: DropPosition): DropPosition {
  return { x: point.x * window.devicePixelRatio, y: point.y * window.devicePixelRatio };
}
function firstSourcePoint(input: HTMLTextAreaElement): DropPosition {
  const rect = input.getBoundingClientRect();
  const style = getComputedStyle(input);
  const scale = rect.width / input.offsetWidth;
  return {
    x: rect.left + parseFloat(style.paddingLeft) * scale,
    y: rect.top + (parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2) * scale,
  };
}
function richTextPoint(offset: number): DropPosition {
  const paragraph = document.querySelector('.editor-tab.active .ProseMirror p');
  const text = paragraph?.firstChild;
  check(text?.nodeType === Node.TEXT_NODE, 'rich text fixture is unavailable');
  const range = document.createRange();
  range.setStart(text, offset);
  range.setEnd(text, offset + 1);
  const rect = range.getBoundingClientRect();
  return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
}
function richPrefix(text: string) {
  const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror');
  const node = editor?.querySelector('p')?.firstChild;
  check(editor && node?.nodeType === Node.TEXT_NODE, 'rich input fixture is unavailable');
  editor.focus();
  document.getSelection()!.setBaseAndExtent(node, 0, node, 0);
  check(document.execCommand('insertText', false, text), 'actual rich typing command failed');
}
function picture(type: 'image/png' | 'image/jpeg', color: string): number[] {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2;
  const context = canvas.getContext('2d')!;
  context.fillStyle = color;
  context.fillRect(0, 0, 2, 2);
  return [...atob(canvas.toDataURL(type).split(',')[1])].map((character) =>
    character.charCodeAt(0),
  );
}

/** Real Milkdown/PM transactions, hit testing, marks and history, with only the
 * native file/stash boundary mocked. Images themselves decode in the browser. */
async function rendered(testCase: ImageDropCase): Promise<string> {
  const tabId = `browser-${testCase}`;
  const paths = ['C:/drop/10.png', 'C:/drop/2.jpg', 'C:/drop/1.png'];
  const binaries = new Map([
    [paths[0], picture('image/png', '#e75b35')],
    [paths[1], picture('image/jpeg', '#355be7')],
    [paths[2], picture('image/png', '#35a75b')],
  ]);
  createNativeMocks({ binaries }).install();
  const host = document.createElement('div');
  host.className = 'milkdown-container';
  Object.assign(host.style, { height: '400px', width: '750px' });
  document.body.append(host);
  const code = testCase === 'image-drop-rendered-code-position';
  const original = code ? '```text\nbefore after\n```' : '**before after**';
  const editor = createEditor(host, original, {
    onUpdate: () => {},
    resolveImageSource: (url) => resolveImageSource(tabId, url),
  });
  await editor.create();
  const reachable = registerImageReachability(tabId, () => getEditorImageReferences(editor));
  try {
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    let dropAt = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('before after')) dropAt = pos + 'before '.length;
    });
    check(dropAt, 'could not locate fixture text');
    // The existing caret deliberately points elsewhere. Mouse coordinates must
    // choose the middle of the text (including CSS zoom), not that old caret.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    host.style.setProperty('--editor-zoom', '1.4');
    const coords = view.coordsAtPos(dropAt);
    const hit = view.posAtCoords({ left: coords.left, top: (coords.top + coords.bottom) / 2 });
    check(hit?.pos === dropAt, 'rendered DOM point did not name the expected text offset');
    const lease = trackEditorPosition(editor, hit.pos);
    check(lease, 'rendered position lease was unavailable');
    if (!code) {
      // New typing during image I/O is a separate edit and maps the anchored
      // drop position forward while retaining both surrounding strong marks.
      view.dispatch(view.state.tr.insertText('prefix ', 1));
      check(lease.read() === dropAt + 'prefix '.length, 'pending rendered anchor did not map');
    }
    const beforeDrop = getCurrentState(editor).markdown;
    const result = await runImageDrop(paths, {
      tabId,
      invalidReason: () => (view.isDestroyed ? 'target-closed' : undefined),
      release: lease.release,
      insert: (tokens) =>
        insertImageBatchAt(
          editor,
          lease.read()!,
          tokens.map((src) => ({ src })),
        ),
    });
    check(result.inserted === 3, 'rich image batch was not inserted');
    view.state.doc.check();
    const nodes: { src: string; pos: number }[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') nodes.push({ src: node.attrs.src, pos });
    });
    check(nodes.length === 3, 'rich batch used text instead of schema image nodes');
    const names = new Map(
      getPendingImages(tabId).map((image) => [image.placeholder, image.filename]),
    );
    check(
      nodes.map((node) => names.get(node.src)).join(',') === '1.png,2.jpg,10.png',
      'rich natural order was wrong',
    );
    await until(() => {
      const images = [...host.querySelectorAll<HTMLImageElement>('.md-image-node > img')];
      return images.length === 3 && images.every((image) => image.naturalWidth > 0);
    }, 'native stash previews should decode');
    if (code) {
      const blocks: string[] = [];
      view.state.doc.forEach((node) => blocks.push(`${node.type.name}:${node.textContent}`));
      check(
        blocks.join('|') === 'code_block:before |paragraph:|code_block:after',
        `code drop did not preserve schema-valid split text: ${blocks.join('|')}`,
      );
      undo(editor);
      check(getCurrentState(editor).markdown === beforeDrop, 'code batch was not one undo');
      redo(editor);
      check(getImageUrls(getCurrentState(editor).markdown).length === 3, 'code batch redo failed');
      return `${testCase}: actual code text split into legal blocks, unchanged text and one batch undo`;
    }
    const afterDrop = getCurrentState(editor).markdown;
    let followingText = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('after')) {
        followingText = pos;
        check(
          node.marks.some((mark) => mark.type.name === 'strong'),
          'suffix lost its strong mark',
        );
      }
    });
    view.dispatch(view.state.tr.insertText('POST ', followingText));
    undo(editor);
    check(
      getCurrentState(editor).markdown === afterDrop,
      'following typing joined the drop history',
    );
    undo(editor);
    check(getCurrentState(editor).markdown === beforeDrop, 'whole rich batch was not one undo');
    undo(editor);
    check(!getCurrentState(editor).markdown.includes('prefix'), 'preceding typing joined the drop');
    redo(editor);
    redo(editor);
    check(
      getImageUrls(getCurrentState(editor).markdown).length === 3,
      'rich batch redo lost images',
    );
    return `${testCase}: zoomed mouse point, transaction mapping, natural order, marks and isolated undo/redo`;
  } catch (error) {
    const images = [...host.querySelectorAll<HTMLImageElement>('img')].map((image) => ({
      src: image.getAttribute('src')?.slice(0, 100),
      loaded: image.naturalWidth,
    }));
    throw Object.assign(
      new Error(
        `${error instanceof Error ? error.message : String(error)}; image DOM ${JSON.stringify(images)}`,
      ),
      { cause: error },
    );
  } finally {
    reachable();
    await editor.destroy();
    clearPendingImages(tabId);
    host.remove();
  }
}

/** Whole-App native drag callback and actual SourceEditor bridge. A synthetic
 * native event uses physical pixels, while normal input/undo acts on real DOM. */
export async function runImageDropRegression(testCase: ImageDropCase): Promise<string> {
  if (
    testCase === 'image-drop-rendered-batch-history' ||
    testCase === 'image-drop-rendered-code-position'
  )
    return rendered(testCase);
  const richApp =
    testCase === 'image-drop-rendered-native-position' ||
    testCase === 'image-drop-rendered-tab-switch' ||
    testCase === 'image-picker-rich-history' ||
    testCase === 'image-picker-progress';
  const picker = testCase.startsWith('image-picker-');
  const dialogSwitch = testCase === 'image-picker-dialog-tab-switch';
  const firstPath = 'C:/notes/a.md';
  const secondPath = 'C:/notes/b.md';
  const savedPath = 'C:/saved/draft.md';
  const draft = testCase === 'image-drop-draft-save-assets';
  const wrapped = testCase === 'image-drop-source-wrapped-position';
  const original = wrapped ? '0123456789'.repeat(1000) : 'before TARGET after';
  const files = new Map([
    [firstPath, original],
    [secondPath, 'other buffer'],
  ]);
  const imagePaths = ['C:/drop/10.png', 'C:/drop/2.jpg', 'C:/drop/1.png'];
  const binaries = new Map([
    [imagePaths[0], picture('image/png', '#e75b35')],
    [imagePaths[1], picture('image/jpeg', '#355be7')],
    [imagePaths[2], picture('image/png', '#35a75b')],
  ]);
  const originalHashes = new Map([...binaries].map(([path, bytes]) => [path, bytes.join(',')]));
  let finishRead!: () => void;
  const readGate = new Promise<void>((resolve) => (finishRead = resolve));
  const delayed =
    testCase.includes('during-read') ||
    testCase.endsWith('tab-switch') ||
    testCase.endsWith('-progress');
  const partial = testCase === 'image-drop-partial-failure';
  let readStarted = false;
  const native = createNativeMocks({
    binaries,
    beforeCommand: async (command, args) => {
      if (
        command === 'import_dropped_image' &&
        delayed &&
        !dialogSwitch &&
        args.path === imagePaths[1]
      ) {
        readStarted = true;
        await readGate;
      }
    },
    fallback: async (command, args) => {
      switch (command) {
        case 'take_startup_files':
          return draft ? [] : [firstPath];
        case 'take_pending_open_files':
        case 'list_recovery_snapshots':
          return [];
        case 'read_document': {
          const path = args.path as string;
          const content = files.get(path);
          check(content !== undefined, `unknown document ${path}`);
          return { path, content, revision: `revision:${content}`, mtime: 1 };
        }
        case 'document_revision': {
          const path = args.path as string;
          const content = files.get(path);
          return {
            path,
            revision: content === undefined ? null : `revision:${content}`,
            mtime: content === undefined ? null : 1,
          };
        }
        case 'write_document': {
          const path = args.path as string;
          const content = args.content as string;
          const previous = files.get(path);
          check(
            args.expectedRevision === (previous === undefined ? null : `revision:${previous}`),
            'document CAS did not match',
          );
          files.set(path, content);
          return { path, revision: `revision:${content}`, mtime: 1, backupPath: null };
        }
        case 'save_image_asset': {
          const filename = args.filename as string;
          const parent = (args.docPath as string).replace(/\/[^/]+$/, '');
          const path = `${parent}/assets/${filename}`;
          binaries.set(path, [...decodeFixtureBase64(args.dataBase64)]);
          return { filename, path, relativePath: `./assets/${filename}`, allocationId: null };
        }
        case 'read_image_file': {
          const path =
            `${(args.docPath as string).replace(/\/[^/]+$/, '')}/${args.relativePath as string}`.replace(
              '/./',
              '/',
            );
          const bytes = binaries.get(path);
          check(bytes, `missing relative fixture image ${path}`);
          const encoded = btoa(String.fromCharCode(...bytes));
          return {
            path,
            mime: /\.jpg$/i.test(path) ? 'image/jpeg' : 'image/png',
            dataBase64: encoded,
          };
        }
        case 'plugin:path|dirname':
          return (args.path as string).replace(/\/[^/]+$/, '');
        case 'plugin:path|join':
          return (args.paths as string[]).join('/').replace('/./', '/');
        case 'plugin:dialog|save':
          return savedPath;
        case 'plugin:dialog|open':
          if (dialogSwitch) {
            readStarted = true;
            await readGate;
          }
          return picker && testCase !== 'image-picker-dialog-cancel' ? imagePaths : null;
        case 'plugin:dialog|message':
          return args.buttons === 'YesNo' ? 'Yes' : 'Ok';
        case 'plugin:window|inner_size':
          return { width: 1200, height: 800 };
        case 'plugin:window|outer_position':
          return { x: 0, y: 0 };
        case 'plugin:window|available_monitors':
          return [];
        case 'plugin:window|is_minimized':
        case 'plugin:window|is_maximized':
          return false;
        case 'cache_recovery_image':
        case 'write_recovery_snapshot':
        case 'delete_recovery_snapshot':
        case 'plugin:window|set_size':
        case 'plugin:window|set_position':
        case 'plugin:window|show':
        case 'plugin:window|set_focus':
        case 'plugin:window|unminimize':
        case 'plugin:window|destroy':
          return;
        default:
          throw new Error(`Unexpected image-drop fixture IPC ${command}`);
      }
    },
  });
  native.install();
  const host = document.createElement('div');
  host.style.height = '100vh';
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(App));
  try {
    if (draft) {
      await until(() => document.querySelector('.welcome'), 'welcome ready');
      click('button[title="新建文档 (Ctrl+N)"]');
      await until(() => document.querySelector('.newfile-card'), 'new draft modal');
      click('.newfile-card');
    }
    await until(
      () => document.querySelector('.editor-tab.active .ProseMirror'),
      'rich editor ready',
    );
    if (!richApp) {
      click('button[aria-label="切换源码模式"]');
      await until(() => activeSource(), 'source editor ready');
    }
    const input = (
      richApp ? document.querySelector<HTMLTextAreaElement>('.source-textarea') : activeSource()
    )!;
    const api = sourceApi(input);
    if (draft) nativeInput(input, original);
    await until(() => api.read().text === original, 'original source text');
    if (richApp) {
      // Milkdown creates its DOM before create() resolves and React publishes
      // onRegister. Let that commit and its passive effects finish before
      // exercising the native callback; DOM existence alone is not readiness.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }
    let point = firstSourcePoint(input);
    let dropAt = 0;
    let beforeDrop = original;
    if (richApp) {
      document
        .querySelector<HTMLElement>('.editor-area')!
        .style.setProperty('--editor-zoom', '1.4');
      point = richTextPoint('before '.length);
      dropAt = 'before '.length;
      const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
      editor.focus();
      const text = editor.querySelector('p')!.firstChild!;
      document.getSelection()!.setBaseAndExtent(text, 0, text, 0);
    } else if (wrapped) {
      // Independently calculate a row in a long unbroken monospace line. A
      // newline/old-caret approximation cannot choose this wrapped/scrolled row.
      input.style.fontFamily = 'monospace';
      input.style.fontSize = '16px';
      input.style.lineHeight = '24px';
      document
        .querySelector<HTMLElement>('.editor-area')!
        .style.setProperty('--editor-zoom', '1.4');
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d')!;
      context.font = '16px monospace';
      const glyph = context.measureText('0').width;
      const paddingLeft = parseFloat(style.paddingLeft);
      const paddingRight = parseFloat(style.paddingRight);
      const columns = Math.floor((input.clientWidth - paddingLeft - paddingRight) / glyph);
      const row = 12;
      const column = 7;
      input.scrollTop = 9 * 24;
      input.setSelectionRange(0, 0);
      const rect = input.getBoundingClientRect();
      const scale = rect.width / input.offsetWidth;
      point = {
        x: rect.left + (paddingLeft + column * glyph) * scale,
        y: rect.top + (parseFloat(style.paddingTop) + (row + 0.5) * 24 - input.scrollTop) * scale,
      };
      dropAt = row * columns + column;
      check(
        sourceOffsetAtPoint(input, point) === dropAt,
        `wrapped hit expected ${dropAt}, received ${sourceOffsetAtPoint(input, point)}`,
      );
    } else if (testCase === 'image-drop-source-batch-history') {
      nativeInput(input, `PRE ${original}`, 4);
      beforeDrop = api.read().text;
      dropAt = sourceOffsetAtPoint(input, point)!;
    }
    if (picker) {
      dropAt = 13;
      if (richApp) {
        const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
        const text = editor.querySelector('p')!.firstChild!;
        editor.focus();
        document.getSelection()!.setBaseAndExtent(text, 7, text, 13);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      } else input.setSelectionRange(7, 13);
    }
    const ratioDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    if (wrapped)
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    try {
      if (picker) click('button[aria-label="插入本地图片"]');
      else
        await emit('tauri://drag-drop', {
          paths: partial ? [...imagePaths, 'C:/drop/3-missing.png'] : imagePaths,
          position: physical(point),
        });
    } finally {
      if (wrapped) {
        if (ratioDescriptor) Object.defineProperty(window, 'devicePixelRatio', ratioDescriptor);
        else delete (window as unknown as Record<string, unknown>).devicePixelRatio;
      }
    }
    if (delayed) {
      await until(() => readStarted, 'second image should wait in native read');
      if (!dialogSwitch) {
        await until(
          () => document.querySelector('.image-drop-notice')?.textContent?.includes('1 / 3'),
          'visible progress while native image reading waits',
        );
        check(
          document.querySelector('.image-drop-notice')?.textContent?.includes('正在插入图片'),
          'incomplete import was reported as completed',
        );
        const button = document.querySelector<HTMLButtonElement>(
          'button[aria-label="插入本地图片"]',
        )!;
        check(
          button.disabled && button.getAttribute('aria-busy') === 'true',
          'image action is not visibly busy',
        );
      }
      if (testCase.endsWith('-progress')) {
        check(
          getImageUrls(api.read().text).length === 0,
          'partial batch became visible before protection finished',
        );
      } else if (testCase === 'image-drop-close-during-read') {
        click('[role="tab"][aria-selected="true"] .tab-close');
        await until(() => !document.querySelector('[role="tab"]'), 'clean target tab closed');
      } else if (
        testCase === 'image-drop-mode-during-read' ||
        testCase === 'image-drop-mode-roundtrip-during-read'
      ) {
        nativeInput(input, `${original} NEW INPUT`);
        click('button[aria-label="切换源码模式"]');
        await until(() => !activeSource(), 'mode changed during native read');
        if (testCase === 'image-drop-mode-roundtrip-during-read') {
          click('button[aria-label="切换源码模式"]');
          await until(() => activeSource(), 'mode returned before native read finished');
        }
      } else {
        if (richApp) {
          richPrefix('NEW INPUT ');
          await until(
            () => api.read().text.includes('NEW INPUT'),
            'rich input published while drop waits',
          );
        } else nativeInput(input, `NEW INPUT ${original}`);
        await emit('tauri://drag-drop', { paths: [secondPath], position: { x: 1, y: 1 } });
        await until(
          () =>
            document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('title') ===
            secondPath,
          'second tab active',
        );
        click('button[aria-label="切换源码模式"]');
        await until(() => activeSource() && activeSource() !== input, 'second source visible');
        activeSource()!.focus();
      }
      finishRead();
    }
    if (testCase.includes('during-read')) {
      await until(() => {
        const notice = document.querySelector('.image-drop-notice')?.textContent;
        return notice && !notice.includes('正在插入图片');
      }, 'cancel notice');
      await until(() => native.stashes.size === 0, 'all canceled stashes released');
      check(
        getImageUrls(api.read().text).length === 0,
        'canceled batch published image references',
      );
      if (
        testCase === 'image-drop-mode-during-read' ||
        testCase === 'image-drop-mode-roundtrip-during-read'
      ) {
        if (!activeSource()) click('button[aria-label="切换源码模式"]');
        await until(() => activeSource(), 'source returned');
        check(
          sourceApi(activeSource()!).read().text.includes('NEW INPUT'),
          'mode cancellation lost new input',
        );
      }
      return `${testCase}: original target cancellation, unchanged input and complete stash cleanup`;
    }
    if (testCase === 'image-picker-dialog-cancel') {
      await until(
        () =>
          !document.querySelector<HTMLButtonElement>('button[aria-label="插入本地图片"]')!.disabled,
        'canceled chooser released its position',
      );
      check(api.read().text === original, 'canceling the chooser edited the source');
      check(
        native.calls.every((call) => call.command !== 'import_dropped_image'),
        'canceled chooser imported an image',
      );
      return `${testCase}: cancel keeps the document unchanged and allows another selection`;
    }
    await until(
      () => getImageUrls(api.read().text).length === 3,
      'three source references inserted',
    );
    const urls = getImageUrls(api.read().text);
    const imports = native.calls.filter((call) => call.command === 'import_dropped_image');
    check(
      native.calls.every((call) => call.command !== 'read_stashed_image'),
      'image insertion still transfers full stash bytes through JavaScript',
    );
    if (testCase.endsWith('-progress'))
      await until(
        () =>
          document.querySelector('.image-drop-notice')?.textContent?.includes('已插入 3 张图片'),
        'successful insertion notice',
      );
    check(
      imports
        .slice(0, 2)
        .map((call) => call.args.path)
        .join(',') === 'C:/drop/1.png,C:/drop/2.jpg',
      'source imports were not natural order',
    );
    check(!api.read().text.includes('base64'), 'source draft retained image bytes');
    const insertion = urls.map((url) => `![](${url})`).join('\n');
    if (picker) {
      const expected = dialogSwitch
        ? `NEW INPUT ${beforeDrop.slice(0, dropAt)}${insertion}${beforeDrop.slice(dropAt)}`
        : beforeDrop.slice(0, dropAt) + insertion + beforeDrop.slice(dropAt);
      if (!richApp)
        check(api.read().text === expected, 'chooser lost selected text or the captured position');
      else
        check(
          api.read().text.includes('TARGET') && api.read().text.trimEnd().endsWith('after'),
          'rich chooser replaced selected text',
        );
      if (dialogSwitch) {
        check(
          activeSource() !== input && sourceApi(activeSource()!).read().text === 'other buffer',
          'chooser redirected the batch to the new tab',
        );
        check(
          document.activeElement === activeSource(),
          'background chooser insertion stole focus',
        );
      } else if (richApp) {
        const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
        const text = [...editor.querySelector('p')!.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join('|');
        check(text === 'before TARGET| after', `rich chooser missed the selection end: ${text}`);
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'z',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await until(() => getImageUrls(api.read().text).length === 0, 'rich picker is one undo');
        check(api.read().text.trimEnd() === original, 'rich picker undo lost original text');
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'y',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await until(
          () => getImageUrls(api.read().text).length === 3,
          'rich picker redo restores the batch',
        );
      } else {
        api.undo();
        check(api.read().text === original, 'source picker is not one undo');
        api.redo();
        check(getImageUrls(api.read().text).length === 3, 'source picker redo lost the batch');
      }
      for (const [path, hash] of originalHashes)
        check(binaries.get(path)?.join(',') === hash, `chooser changed source image ${path}`);
      return `${testCase}: selection preserved, captured original tab, natural order and one batch undo`;
    }
    if (testCase.endsWith('tab-switch')) {
      if (richApp) {
        check(
          api.read().text.startsWith('NEW INPUT before ![]('),
          'rich anchor lost preceding new input',
        );
        check(
          api.read().text.trimEnd().endsWith('TARGET after'),
          'rich anchor replaced suffix text',
        );
      } else
        check(
          api.read().text === `NEW INPUT ${insertion}${original}`,
          'asynchronous original source anchor lost or replaced new input',
        );
      check(
        activeSource() !== input && sourceApi(activeSource()!).read().text === 'other buffer',
        'late batch edited the active second tab',
      );
      check(document.activeElement === activeSource(), 'late background insertion stole focus');
      return `${testCase}: new input retained, original hidden editor receives batch and second tab keeps focus`;
    }
    if (richApp) {
      const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
      const paragraph = editor.querySelector('p')!;
      const text = [...paragraph.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent);
      check(
        text.join('|') === 'before |TARGET after',
        `rich native mouse drop used the old caret: ${text.join('|')}`,
      );
      check(
        paragraph.querySelectorAll('.md-image-node').length === 3,
        'native callback did not create three rich image nodes',
      );
      await until(() => {
        const images = [...paragraph.querySelectorAll<HTMLImageElement>('.md-image-node > img')];
        return images.length === 3 && images.every((image) => image.naturalWidth > 0);
      }, 'rich native previews decoded');
      check(
        document.activeElement === editor,
        'foreground rich drop did not focus the original editor',
      );
      return `${testCase}: whole-App physical drop callback uses zoomed mouse point, real image nodes and foreground focus`;
    }
    check(
      api.read().text === beforeDrop.slice(0, dropAt) + insertion + beforeDrop.slice(dropAt),
      'source batch did not use the original measured mouse point',
    );
    if (testCase === 'image-drop-source-batch-history') {
      const withDrop = api.read().text;
      nativeInput(input, `${withDrop} POST`);
      api.undo();
      check(api.read().text === withDrop, 'following source typing joined the drop');
      api.undo();
      check(api.read().text === beforeDrop, 'source drop was not a single undo');
      api.undo();
      check(api.read().text === original, 'preceding source typing joined the drop');
      api.redo();
      api.redo();
      check(getImageUrls(api.read().text).length === 3, 'source batch redo lost references');
    } else if (draft) {
      check(
        native.calls.every((call) => call.command !== 'save_image_asset'),
        'unsaved draft copied assets before saving',
      );
      click('button[title^="保存 (Ctrl+S)"]');
      await until(
        () => files.has(savedPath) && !api.read().text.includes('mdplus-image:'),
        'first save migrated draft images',
      );
      const saved = files.get(savedPath)!;
      check(
        getImageUrls(saved).every((url) => url.startsWith('./assets/')),
        'saved draft did not use relative assets',
      );
      check(getImageUrls(saved).length === 3, 'first save lost draft images');
      for (const url of getImageUrls(saved)) {
        const path = `C:/saved/${decodeURIComponent(url).replace(/^\.\//, '')}`;
        check(binaries.has(path), `saved asset missing ${path}`);
      }
      api.undo();
      check(
        getImageUrls(api.read().text).length === 0,
        'undo after first save did not remove one whole batch',
      );
      api.redo();
      check(
        getImageUrls(api.read().text).length === 3,
        'redo after first save lost asset references',
      );
    } else if (partial) {
      await until(
        () => document.querySelector('.image-drop-notice')?.textContent?.includes('已插入 3'),
        'partial failure summary',
      );
      check(
        document.querySelector('.image-drop-notice')?.textContent?.includes('3-missing.png'),
        'failed image path was absent from summary',
      );
      api.undo();
      check(api.read().text === original, 'partial batch was not one undo');
    } else {
      api.undo();
      check(api.read().text === original, 'wrapped source batch undo failed');
    }
    for (const [path, hash] of originalHashes)
      check(binaries.get(path)?.join(',') === hash, `user source changed: ${path}`);
    return `${testCase}: real source mouse hit, compact natural batch, isolated history and original files retained`;
  } catch (error) {
    const diagnostic = {
      notice: host.querySelector('.image-drop-notice')?.textContent,
      imports: native.calls
        .filter((call) => call.command === 'import_dropped_image')
        .map((call) => call.args.path),
      source: host.querySelector<HTMLTextAreaElement>('.source-textarea')?.value.slice(0, 300),
      starting: host.querySelector('.app')?.getAttribute('data-starting'),
    };
    throw Object.assign(
      new Error(
        `${error instanceof Error ? error.message : String(error)}; app ${JSON.stringify(diagnostic)}`,
      ),
      { cause: error },
    );
  } finally {
    finishRead();
    root.unmount();
    host.remove();
  }
}
