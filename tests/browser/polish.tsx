import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { DEFAULT_SHORTCUTS } from '../../src/lib/shortcuts';
import { createNativeMocks } from './nativeMocks';

export const polishCases = [
  'polish-source-outline',
  'polish-source-outline-reduced',
  'polish-source-outline-large-input',
  'polish-source-outline-syntax',
  'polish-shortcuts-recents',
  'polish-contrast',
  'polish-document-links',
  'polish-document-link-save-as',
  'polish-document-link-unsaved',
  'polish-recent-read-failure',
  'polish-recent-write-failure',
] as const;
export type PolishCase = (typeof polishCases)[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Polish: ${message}`);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => unknown, message: string) {
  const end = performance.now() + 15000;
  while (!condition()) {
    check(performance.now() < end, `timed out: ${message}`);
    await frame();
  }
}
function click(selector: string) {
  const control = document.querySelector<HTMLElement>(selector);
  check(control, `missing ${selector}`);
  control.click();
}
const source = () =>
  document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea');
function inputText(input: HTMLTextAreaElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}
const activePath = () =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('title');
function link(text: string) {
  const anchor = [
    ...document.querySelectorAll<HTMLAnchorElement>('.editor-tab.active .ProseMirror a'),
  ].find((item) => item.textContent === text);
  check(anchor, `missing link ${text}`);
  return anchor;
}
function clickLink(text: string, ctrlKey = true) {
  const anchor = link(text);
  const rect = anchor.getBoundingClientRect();
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    ctrlKey,
    clientX: rect.left + 1,
    clientY: rect.top + 1,
  });
  anchor.dispatchEvent(event);
  check(event.defaultPrevented, 'link escaped into default WebView navigation');
}
async function enterLink(text: string) {
  const anchor = link(text);
  const editor = anchor.closest<HTMLElement>('.ProseMirror')!;
  editor.focus();
  document.getSelection()!.setBaseAndExtent(anchor.firstChild!, 2, anchor.firstChild!, 2);
  await frame();
  await frame();
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  editor.dispatchEvent(event);
  check(event.defaultPrevented, 'Ctrl+Enter did not consume the link action');
}
function contrast(foreground: string, background: string) {
  const luminance = (color: string) =>
    (color.match(/[\d.]+/g) ?? [])
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Real application/editor/CSS with a closed, in-memory native file boundary. */
export async function runPolishRegression(testCase: PolishCase): Promise<string> {
  const outline = testCase.startsWith('polish-source-outline');
  const welcome = [
    'polish-shortcuts-recents',
    'polish-contrast',
    'polish-document-link-unsaved',
    'polish-recent-read-failure',
  ].includes(testCase);
  const sourcePath = 'C:/notes/source.md';
  const targetPath = 'C:/notes/target note.md';
  const savePath = 'C:/other/source.md';
  const markdown =
    testCase === 'polish-source-outline-syntax'
      ? '# 中文 😀 **加粗** [链接][doc] `code` ![alt](https://example.com/a.png)\n\n坏公式 $\\notACommand$。\n\nSetext 标题\n---\n\n```md\n# 不是标题\n```\n\n$$\n# 也不是标题\n$$\n\n> ## 引用标题\n\n## 重复\n\n## 重复\n\n[doc]: ./target%20note.md\n'
      : outline
        ? Array.from(
            { length: 40 },
            (_, index) => `## Heading ${index}\n\n${('paragraph ' + index + ' ').repeat(60)}\n`,
          ).join('\n')
        : '[Target](./target%20note.md) [Alias](./sub/../target%20note.md) [Missing](./missing.md) [Anchor](./target%20note.md#title)\n';
  const files = new Map([
    [sourcePath, markdown],
    [targetPath, '# Target\n\nOriginal target.\n'],
    ['C:/other/target note.md', '# New directory target\n'],
  ]);
  const recent = [
    { path: 'C:/project-a/README.md', name: 'README.md', time: 2 },
    { path: 'C:/project-b/README.md', name: 'README.md', time: 1 },
  ];
  const settings = new Map<string, unknown>([
    ['recent-files', recent],
    ['session-restore-enabled', false],
  ]);
  if (testCase === 'polish-shortcuts-recents')
    settings.set('shortcuts', {
      ...DEFAULT_SHORTCUTS,
      new: ['f9'],
      open: ['f8'],
      save: ['f7'],
      search: ['f6'],
    });
  const messages: string[] = [];
  const defaults = createNativeMocks({ settings });
  const native = createNativeMocks({
    settings,
    beforeLoadSettings: () => {
      if (testCase === 'polish-recent-read-failure')
        throw new Error('synthetic settings read failure');
    },
    beforeSaveSettings: (values, previous) => {
      if (
        testCase === 'polish-recent-write-failure' &&
        JSON.stringify(values['recent-files']) !== JSON.stringify(previous.values['recent-files'])
      )
        throw new Error('synthetic recent write failure');
    },
    fallback: async (command, args) => {
      const path = typeof args.path === 'string' ? args.path.replace(/\\/g, '/') : '';
      if (command === 'take_startup_files') return welcome ? [] : [sourcePath];
      if (command === 'read_document') {
        const content = files.get(path);
        check(content !== undefined, `missing fixture file ${path}`);
        return { path, content, revision: `bytes:${content}`, mtime: 1 };
      }
      if (command === 'document_revision') {
        const content = files.get(path);
        return {
          path,
          revision: content === undefined ? null : `bytes:${content}`,
          mtime: content === undefined ? null : 1,
        };
      }
      if (command === 'write_document') {
        const previous = files.get(path);
        check(
          args.expectedRevision === (previous === undefined ? null : `bytes:${previous}`),
          'write lost its expected byte revision',
        );
        files.set(path, String(args.content));
        return { path, revision: `bytes:${args.content}`, mtime: 2, backupPath: null };
      }
      if (command === 'plugin:dialog|save') return savePath;
      if (command === 'plugin:dialog|message') {
        messages.push(String(args.message));
        return 'Ok';
      }
      return defaults.invoke(command, args);
    },
  });
  native.install();
  const host = document.createElement('div');
  host.style.height = '100vh';
  document.body.append(host);
  const root = createRoot(host);
  root.render(<App />);
  try {
    await until(
      () =>
        welcome
          ? document.querySelector('.welcome')
          : document.querySelector(
              '.editor-tab.active .ProseMirror a, .editor-tab.active .ProseMirror h1, .editor-tab.active .ProseMirror h2',
            ),
      'application ready',
    );
    await frame();
    await frame();
    if (outline) {
      if (testCase === 'polish-source-outline-syntax') {
        const errors = [
          ...document.querySelectorAll<HTMLElement>(
            '.editor-tab.active .katex-error[role="alert"]',
          ),
        ];
        check(
          errors.length === 2 &&
            errors.every((error) => error.textContent?.startsWith('公式有误：')),
          'invalid inline/block math has no readable error',
        );
        for (const theme of ['light', 'dark']) {
          document.documentElement.dataset.theme = theme;
          await new Promise<void>((resolve) => setTimeout(resolve, 180));
          for (const error of errors)
            check(
              contrast(
                getComputedStyle(error).color,
                getComputedStyle(document.querySelector('.editor-area')!).backgroundColor,
              ) >= 4.5,
              'math error text fails AA contrast',
            );
        }
        check(files.get(sourcePath) === markdown, 'invalid math changed the source file');
      }
      click('button[aria-label="切换源码模式"]');
      await until(source, 'source visible');
      click('button[aria-label="打开目录"]');
      await until(
        () =>
          document.querySelectorAll('.outline-item').length ===
          (testCase === 'polish-source-outline-syntax' ? 5 : 40),
        'source headings ready',
      );
      const input = source()!;
      if (testCase === 'polish-source-outline-syntax') {
        const items = [...document.querySelectorAll<HTMLElement>('.outline-item')];
        check(
          items.map((item) => item.textContent).join('|') ===
            '中文 😀 加粗 链接 code |Setext 标题|引用标题|重复|重复',
          'worker headings differ from the rich Markdown grammar',
        );
        for (const [index, text] of ['Setext 标题', '## 引用标题', '## 重复'].entries()) {
          items[index + 1].click();
          check(input.selectionStart === markdown.indexOf(text), 'worker lost source offsets');
        }
      } else if (testCase === 'polish-source-outline-large-input') {
        const body = 'source line source line source line\n'.repeat(30000);
        const large = '# Latest title\n\n' + body;
        const start = performance.now();
        inputText(input, large);
        check(performance.now() - start < 400, 'source outline parsing blocked the input callback');
        const responsive = performance.now();
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        const elapsed = performance.now() - responsive;
        check(elapsed < 1000, `source parser blocked the main thread (${Math.round(elapsed)}ms)`);
        inputText(input, '# Current title\n\n```\n' + body + '```\n');
        await until(
          () => document.querySelector('.outline-item')?.textContent?.includes('Current title'),
          'large source outline cancelled obsolete parsing and refreshed',
        );
        check(
          document.querySelectorAll('.outline-item').length === 1,
          'large source kept old headings',
        );
      } else {
        inputText(input, input.value.replace('Heading 0', 'Renamed title'));
        await until(
          () => document.querySelector('.outline-item')?.textContent?.includes('Renamed title'),
          'source rename reflected in outline',
        );
        input.scrollTop = 0;
        input.setSelectionRange(0, 0);
        const calls: ScrollToOptions[] = [];
        const scrollTo = input.scrollTo.bind(input);
        input.scrollTo = ((options: ScrollToOptions) => {
          calls.push(options);
          scrollTo(options);
        }) as typeof input.scrollTo;
        const before = input.value;
        document.querySelectorAll<HTMLElement>('.outline-item')[35].click();
        check(
          input.selectionStart === input.value.indexOf('## Heading 35'),
          'outline did not select the current source heading offset',
        );
        check(document.activeElement === input, 'outline did not focus source');
        check(
          calls.length === 1 &&
            calls[0].behavior ===
              (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'),
          'source outline ignored motion preferences or scrolled twice',
        );
        await until(() => input.scrollTop > 0, 'source outline scrolled');
        check(input.value === before, 'outline changed Markdown');
        if (testCase === 'polish-source-outline') {
          const OriginalWorker = window.Worker;
          try {
            window.Worker = class {
              constructor() {
                throw new Error('synthetic worker creation failure');
              }
            } as unknown as typeof Worker;
            click('button[aria-label="打开目录"]');
            await frame();
            inputText(input, '# Retry title\n');
            click('button[aria-label="打开目录"]');
            await until(
              () => document.querySelector('.outline-empty[role="alert"]'),
              'worker failure is perceivable',
            );
          } finally {
            window.Worker = OriginalWorker;
          }
          click('button[aria-label="打开目录"]');
          await frame();
          click('button[aria-label="打开目录"]');
          await until(
            () => document.querySelector('.outline-item')?.textContent === 'Retry title',
            'reopening the outline retries worker creation',
          );
          check(input.value === '# Retry title\n', 'worker failure changed the document');
        }
      }
    } else if (testCase === 'polish-shortcuts-recents') {
      await until(
        () => document.querySelector('.toolbar button[title="新建文档 (F9)"]'),
        'custom shortcuts loaded',
      );
      check(
        document.querySelector('.toolbar button[title="打开 (F8)"]'),
        'open hint kept default shortcut',
      );
      check(
        document.querySelector('.tabbar-new')?.getAttribute('title') === '新建文档 (F9)',
        'tab hint kept default shortcut',
      );
      const recents = [...document.querySelectorAll('.welcome-recent-item')];
      check(
        recents.length === 2 &&
          recents[0].textContent?.includes('project-a') &&
          recents[1].textContent?.includes('project-b'),
        'same-name recent documents lack directory identity',
      );
      check(
        recents.every(
          (item) =>
            item.getAttribute('aria-label')?.includes('README.md') &&
            item.getAttribute('title')?.includes('README.md'),
        ),
        'recent paths are inaccessible',
      );
      click('.tabbar-new');
      await until(() => document.querySelector('.newfile-card'), 'new document chooser');
      click('.newfile-card');
      await until(() => document.querySelector('.status-save-unsaved'), 'new draft status');
      check(
        document.querySelector('.status-save-unsaved')?.getAttribute('title')?.includes('F7'),
        'save status did not follow current binding',
      );
      click('button[aria-label="打开快捷键设置"]');
      await until(
        () => document.querySelector('button[aria-label="移除「保存」的 F7"]'),
        'shortcut settings ready',
      );
      click('button[aria-label="移除「保存」的 F7"]');
      await until(
        () =>
          !document
            .querySelector('.toolbar button[title^="保存"]')
            ?.getAttribute('title')
            ?.includes('F7'),
        'live unbinding updates the save hint',
      );
      check(
        document
          .querySelector('.status-save-unsaved')
          ?.getAttribute('title')
          ?.includes('点击工具栏'),
        'unbound save hint lacks working action',
      );
    } else if (testCase === 'polish-contrast') {
      const primary = document.querySelector<HTMLElement>('.welcome .btn-primary')!;
      const commit = document.createElement('button');
      commit.className = 'md-mermaid-commit';
      commit.textContent = '预览';
      host.append(commit);
      const highlight = document.createElement('span');
      highlight.className = 'md-search-hl md-search-current';
      highlight.textContent = 'matched text';
      host.append(highlight);
      for (const theme of ['light', 'dark']) {
        document.documentElement.dataset.theme = theme;
        await new Promise<void>((resolve) => setTimeout(resolve, 180));
        for (const element of [primary, commit, highlight]) {
          const style = getComputedStyle(element);
          check(
            contrast(style.color, style.backgroundColor) >= 4.5,
            `${theme} ${element.className} text fails AA contrast`,
          );
        }
        // Both hover rules use accent-text; measure that same palette through actual CSS variables.
        for (const element of [primary, commit]) {
          element.style.background = 'var(--accent-text)';
          await new Promise<void>((resolve) => setTimeout(resolve, 180));
          const style = getComputedStyle(element);
          check(
            contrast(style.color, style.backgroundColor) >= 4.5,
            `${theme} hover text fails AA contrast`,
          );
          element.style.removeProperty('background');
        }
      }
    } else if (testCase === 'polish-recent-read-failure') {
      await until(
        () => messages.some((message) => message.includes('无法读取最近列表')),
        'recent read failure feedback after window reveal',
      );
      check(native.geometry.visible, 'failed recents prevented window reveal');
    } else if (testCase === 'polish-recent-write-failure') {
      await until(
        () => messages.some((message) => message.includes('最近列表更新失败')),
        'open recent write feedback',
      );
      check(activePath() === sourcePath, 'recent failure discarded the opened document');
      click('button[title="另存为"]');
      await until(
        () =>
          files.has(savePath) &&
          messages.some((message) => message.includes('文稿已保存，但最近列表')),
        'Save As succeeded independently of recents',
      );
      check(activePath() === savePath, 'recent failure prevented new saved identity');
      check(
        !messages.some((message) => message.includes('另存为失败')),
        'recent write failure was mislabeled as document save failure',
      );
      check(
        JSON.stringify(settings.get('recent-files')) === JSON.stringify(recent),
        'failed recent write left a false-success list',
      );
    } else {
      if (testCase === 'polish-document-link-unsaved') {
        click('.tabbar-new');
        await until(() => document.querySelector('.newfile-card'), 'new draft chooser');
        click('.newfile-card');
        await until(
          () => document.querySelector('.editor-tab.active .ProseMirror'),
          'draft editor ready',
        );
        click('button[aria-label="切换源码模式"]');
        await until(source, 'draft source ready');
        inputText(source()!, markdown);
        click('button[aria-label="切换源码模式"]');
        await until(
          () => !source() && document.querySelector('.editor-tab.active .ProseMirror a'),
          'draft links rendered',
        );
        clickLink('Target');
        await until(
          () => messages.some((message) => message.includes('请先保存')),
          'unsaved source feedback',
        );
        check(
          native.calls.every((call) => call.command !== 'read_document'),
          'unsaved source guessed a relative directory',
        );
      } else if (testCase === 'polish-document-link-save-as') {
        click('button[title="另存为"]');
        await until(() => activePath() === savePath, 'Save As adopted new source directory');
        await enterLink('Target');
        await until(
          () => activePath() === 'C:/other/target note.md',
          'link uses current saved directory',
        );
      } else {
        const initialUrl = location.href;
        clickLink('Target', false);
        await frame();
        check(
          location.href === initialUrl && document.querySelectorAll('[role="tab"]').length === 1,
          'ordinary click opened a document',
        );
        clickLink('Target');
        await until(() => activePath() === targetPath, 'Ctrl+click opened relative target');
        click('button[aria-label="切换源码模式"]');
        await until(source, 'target source ready');
        inputText(source()!, '# Edited target retained\n');
        click(`[role="tab"][title="${sourcePath}"]`);
        await until(
          () => !source() && document.querySelector('.editor-tab.active .ProseMirror a'),
          'original source active',
        );
        await enterLink('Alias');
        await until(() => activePath() === targetPath, 'Ctrl+Enter reused alias target');
        check(
          source()?.value.includes('Edited target retained'),
          'duplicate open overwrote the edited target',
        );
        check(
          document.querySelectorAll('[role="tab"]').length === 2 &&
            native.calls.filter(
              (call) => call.command === 'read_document' && call.args.path === targetPath,
            ).length === 1,
          'duplicate link read or created another tab',
        );
        click(`[role="tab"][title="${sourcePath}"]`);
        await until(() => !source(), 'source restored');
        clickLink('Missing');
        await until(
          () => messages.some((message) => message.includes('无法打开文件')),
          'missing link reported',
        );
        check(
          document.querySelectorAll('[role="tab"]').length === 2,
          'missing link created a file or tab',
        );
        clickLink('Anchor');
        await until(
          () => messages.some((message) => message.includes('未定位到标题')),
          'fragment limitation reported',
        );
        check(
          activePath() === targetPath && location.href === initialUrl,
          'fragment did not open its document safely',
        );
      }
    }
    return `${testCase}: passed (real React/Milkdown/CSS and in-memory native boundary)`;
  } finally {
    root.unmount();
    host.remove();
  }
}
