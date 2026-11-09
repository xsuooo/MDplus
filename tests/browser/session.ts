import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { textAnchor, type SessionEditorPlace } from '../../src/lib/sessionPosition';
import type { SavedDocumentSession } from '../../src/lib/documentSession';
import { getSourceEditorApi } from '../../src/lib/sourceEditorApi';
import { measureSourceText } from '../../src/lib/sourcePosition';
import { createNativeMocks } from './nativeMocks';

export const sessionCases = [
  'session-latest-disk',
  'session-startup-priority',
  'session-failure-retry',
  'session-close-cancel',
  'session-untitled-discard',
  'session-disabled',
] as const;
export type SessionCase = (typeof sessionCases)[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => unknown, label: string) {
  const deadline = performance.now() + 15000;
  while (!condition()) {
    check(performance.now() < deadline, `Session regression timed out: ${label}`);
    await frame();
  }
}
async function observe(milliseconds: number) {
  const deadline = performance.now() + milliseconds;
  do {
    await frame();
  } while (performance.now() < deadline);
}
function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  check(button && !button.disabled, `Missing enabled button: ${selector}`);
  button.click();
}
function button(label: string) {
  const target = [...document.querySelectorAll<HTMLButtonElement>('.modal button')].find(
    (item) => item.textContent?.trim() === label,
  );
  check(target && !target.disabled, `Missing modal button: ${label}`);
  target.click();
}
const filePath = (name: string) => `C:/session-fixture/${name}.md`;
function tabPaths() {
  return [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) =>
    tab.title.replace(/\\/g, '/'),
  );
}
async function selectFile(name: string) {
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (item) => item.title.replace(/\\/g, '/') === filePath(name),
  );
  check(tab, `Missing tab: ${name}`);
  tab.click();
  await until(
    () => tab.isConnected && tab.getAttribute('aria-selected') === 'true',
    `selected tab: ${name}`,
  );
}
async function sourceField() {
  if (!document.querySelector('.source-editor:not([hidden])'))
    click('button[aria-label="切换源码模式"]');
  const ready: { input?: HTMLTextAreaElement } = {};
  await until(() => {
    const candidate = document.querySelector<HTMLTextAreaElement>(
      '.source-editor:not([hidden]) .source-textarea',
    );
    if (!candidate || !getSourceEditorApi(candidate)) return false;
    ready.input = candidate;
    return true;
  }, 'active source editor command registration');
  check(ready.input?.isConnected, 'Source editor became detached');
  return ready.input;
}
function prepend(input: HTMLTextAreaElement, text: string) {
  check(
    getSourceEditorApi(input)?.applyEdits([{ from: 0, to: 0, text }]),
    'Source edit was not accepted',
  );
}

/** Real App, source controller and Milkdown; only disk/settings/window IPC is simulated. */
export async function runSessionRegression(testCase: SessionCase): Promise<string> {
  const original = Array.from(
    { length: 30 },
    (_, index) =>
      `## Section ${index}\n\n段落 ${index} 中文 Markdown position anchor. ${'Wrapped paragraph text. '.repeat(8)}\n`,
  ).join('\n');
  const latest = '# External title inserted\n\n磁盘上的新增正文。\n\n' + original;
  const selected = '段落 17';
  const sourcePlace: SessionEditorPlace = {
    sourceMode: true,
    start: textAnchor(original, original.indexOf(selected)),
    end: textAnchor(original, original.indexOf(selected) + selected.length),
    direction: 'backward',
    top: 1400,
    left: 0,
    scroll: { anchor: textAnchor(original, original.indexOf('## Section 17')), gap: 0 },
  };
  const renderedPlace: SessionEditorPlace = {
    sourceMode: false,
    start: textAnchor(original, original.indexOf('段落 10')),
    end: textAnchor(original, original.indexOf('段落 10') + '段落 10'.length),
    direction: 'forward',
    top: 900,
    left: 0,
    scroll: {
      anchor: textAnchor(original, original.indexOf('## Section 10')),
      gap: 0,
      fraction: 0,
    },
  };
  const names =
    testCase === 'session-untitled-discard'
      ? ['a']
      : testCase === 'session-startup-priority' || testCase === 'session-failure-retry'
        ? ['a', 'b', 'c']
        : ['a', 'b'];
  const saved: SavedDocumentSession = {
    version: 1,
    documents: names.map((name) => ({
      path: filePath(name),
      title: `${name}.md`,
      ...(testCase === 'session-latest-disk'
        ? { place: name === 'a' ? sourcePlace : renderedPlace }
        : {}),
    })),
    activePath: filePath(testCase === 'session-failure-retry' ? 'b' : 'a'),
  };
  const settings = new Map<string, unknown>([
    ['document-session', structuredClone(saved)],
    ['session-restore-enabled', testCase !== 'session-disabled'],
    ['source-mode', false],
  ]);
  const files = new Map(
    ['a', 'b', 'c', 'd'].map((name) => [
      filePath(name),
      testCase === 'session-latest-disk'
        ? latest
        : `# Latest ${name.toUpperCase()}\n\nCurrent disk document ${name}.\n`,
    ]),
  );
  if (testCase === 'session-failure-retry') files.delete(filePath('b'));
  const startup =
    testCase === 'session-startup-priority'
      ? [filePath('c'), filePath('d')]
      : testCase === 'session-disabled'
        ? [filePath('d')]
        : [];
  const reads: string[] = [];
  const writes: string[] = [];
  const messages: string[] = [];
  const defaults = createNativeMocks();
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let retrying = false;
  const native = createNativeMocks({
    settings,
    async fallback(command, args) {
      if (command === 'take_startup_files') return startup.splice(0);
      if (command === 'take_pending_open_files') return [];
      if (command === 'read_document') {
        const requested = String(args.path);
        reads.push(requested);
        if (retrying && requested === filePath('b')) await retryGate;
        const content = files.get(requested);
        check(content !== undefined, `Temporarily unavailable: ${requested}`);
        return { path: requested, content, revision: `disk:${content}`, mtime: 1 };
      }
      if (command === 'document_revision') {
        const requested = String(args.path);
        const content = files.get(requested);
        return {
          path: requested,
          revision: content === undefined ? null : `disk:${content}`,
          mtime: content === undefined ? null : 1,
        };
      }
      if (command === 'write_document') {
        writes.push(String(args.path));
        if (testCase === 'session-close-cancel')
          throw new Error('The close fixture retains dirty drafts');
        files.set(String(args.path), String(args.content));
        return { path: args.path, revision: `disk:${args.content}`, mtime: 2, backupPath: null };
      }
      if (command === 'plugin:dialog|message') {
        messages.push(String(args.message));
        return args.buttons === 'YesNo' ? 'No' : 'Ok';
      }
      if (command === 'list_recovery_snapshots')
        return [...native.recoverySnapshots.values()]
          .filter((entry) => !(args.activeIds as string[]).includes(String(entry.id)))
          .map((entry) => ({
            id: entry.id,
            title: entry.title,
            originalPath: entry.originalPath,
            updatedAt: 1,
            damaged: false,
          }));
      if (command === 'read_recovery_snapshot')
        return {
          snapshot: structuredClone(native.recoverySnapshots.get(String(args.id))),
          images: [],
        };
      if (command === 'write_recovery_snapshot') {
        const value = args.snapshot as Record<string, unknown>;
        native.recoverySnapshots.set(String(value.id), structuredClone(value));
        return;
      }
      if (command === 'delete_recovery_snapshot') {
        native.recoverySnapshots.delete(String(args.id));
        return;
      }
      return defaults.invoke(command, args);
    },
  });
  const independentId = 'independent-old-draft';
  if (testCase === 'session-latest-disk' || testCase === 'session-untitled-discard')
    native.recoverySnapshots.set(independentId, {
      id: independentId,
      title: 'Independent pending draft.md',
      originalPath: filePath('a'),
      markdown: 'Independent unsaved body',
      images: [],
    });
  native.install();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(App));
  try {
    await until(
      () =>
        document.querySelector('.app[data-starting="false"]') &&
        document.querySelector('[role="tab"]'),
      'restored startup',
    );
    if (native.recoverySnapshots.has(independentId)) {
      await until(() => document.querySelector('.recovery-modal'), 'independent draft prompt');
      button('稍后处理');
      await until(() => !document.querySelector('.recovery-modal'), 'draft prompt dismissal');
    }
    if (testCase === 'session-latest-disk') {
      const input = await sourceField();
      await document.fonts.ready;
      await frame();
      check(
        input.value === latest,
        'Session restoration wrote an old document body into the source view',
      );
      check(
        input.value.slice(input.selectionStart, input.selectionEnd) === selected &&
          input.selectionDirection === 'backward',
        'Source selection did not map to current disk text',
      );
      const expectedTop = measureSourceText(input, latest, (top) =>
        top(latest.indexOf('## Section 17')),
      );
      check(
        Math.abs(input.scrollTop - expectedTop) < 3,
        `Source reading anchor moved: ${input.scrollTop} versus ${expectedTop}`,
      );
      await selectFile('b');
      await until(
        () => document.querySelector('.editor-tab.active .ProseMirror'),
        'rendered restored tab',
      );
      await frame();
      const rich = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
      rich.focus({ preventScroll: true });
      await frame();
      check(
        window.getSelection()?.toString() === '段落 10',
        'Rendered selection did not map from the serialized Markdown anchors',
      );
      const scroller = rich.closest<HTMLElement>('.milkdown-container')!;
      const heading = [...rich.querySelectorAll<HTMLElement>('h2')].find(
        (node) => node.textContent === 'Section 10',
      )!;
      check(
        Math.abs(heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top) < 3,
        'Rendered reading anchor moved after reopening',
      );
      check(
        files.get(filePath('a')) === latest && writes.length === 0,
        'Restoration overwrote disk content',
      );
      check(
        native.recoverySnapshots.has(independentId),
        'Restoring saved files cleared an independent pending draft',
      );
      return `${testCase}: latest bodies, source/rendered selections and reading anchors, independent draft retained`;
    }
    if (testCase === 'session-startup-priority') {
      await until(() => tabPaths().length === 4, 'all restored/requested tabs');
      check(
        tabPaths().join('|') === ['a', 'b', 'c', 'd'].map(filePath).join('|'),
        'Startup request changed restored order or opened a duplicate path',
      );
      check(
        document
          .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
          ?.title.replace(/\\/g, '/') === filePath('d'),
        'This launch request did not receive priority',
      );
      check(
        reads.filter((requested) => requested === filePath('c')).length === 1,
        'The same startup/restored path was read twice',
      );
      return `${testCase}: saved tab order, same-path reuse, requested file active`;
    }
    if (testCase === 'session-failure-retry') {
      await until(
        () => document.querySelector('.session-restore-notice li'),
        'aggregated restoration failure',
      );
      check(
        tabPaths().join('|') === ['a', 'c'].map(filePath).join('|') && messages.length === 0,
        'One failed path blocked other tabs or opened native error dialogs',
      );
      await until(
        () =>
          (settings.get('document-session') as SavedDocumentSession).documents.some(
            (entry) => entry.path === filePath('b'),
          ),
        'retained failure record',
      );
      click('button[aria-label="关闭会话恢复提示"]');
      await observe(650);
      check(
        (settings.get('document-session') as SavedDocumentSession).documents.some(
          (entry) => entry.path === filePath('b'),
        ),
        'Automatic session persistence removed the failed document record',
      );
      check(
        !document.querySelector('.session-restore-notice'),
        'A dismissed failure banner reappeared without a changed failure',
      );
      click('button[aria-label="打开最近文件"]');
      await until(
        () => document.querySelector('.recent-session-retry'),
        'retry entry after dismissal',
      );
      files.set(filePath('b'), '# Latest B after transient failure\n');
      retrying = true;
      click('.recent-session-retry');
      await until(
        () => document.querySelector<HTMLButtonElement>('.recent-session-retry')?.disabled,
        'busy retry guard',
      );
      releaseRetry();
      await until(
        () => tabPaths().length === 3 && !document.querySelector('.recent-session-retry'),
        'retried restored file',
      );
      check(
        tabPaths().join('|') === ['a', 'b', 'c'].map(filePath).join('|'),
        'Retried file did not return to its saved slot',
      );
      check(
        reads.filter((requested) => requested === filePath('b')).length === 2 &&
          messages.length === 0,
        'Retry duplicated I/O or opened native dialogs',
      );
      return `${testCase}: partial startup, durable failed path, dismissed banner, menu retry and original slot restored`;
    }
    if (testCase === 'session-disabled') {
      check(
        tabPaths().join('|') === filePath('d'),
        'Disabled restoration reopened a previous document',
      );
      check(
        !reads.includes(filePath('a')) && !reads.includes(filePath('b')),
        'Disabled restoration read old file bodies',
      );
      click('button[aria-label="打开最近文件"]');
      await until(
        () => document.querySelector('.recent-session-setting:not(:disabled)'),
        'session preference switch',
      );
      check(
        document.querySelector('.recent-session-setting')?.getAttribute('aria-checked') === 'false',
        'The off preference was not visible',
      );
      click('.recent-session-setting');
      await until(
        () => settings.get('session-restore-enabled') === true,
        'durable preference change',
      );
      return `${testCase}: disabled session respected, launch request opened, preference reenabled`;
    }
    if (testCase === 'session-untitled-discard') {
      click('button[title="新建文档 (Ctrl+N)"]');
      await until(() => document.querySelector('.newfile-card'), 'new document chooser');
      click('.newfile-card');
      const input = await sourceField();
      prepend(input, 'Explicitly abandoned untitled draft\n');
      await until(() => native.recoverySnapshots.size === 2, 'untitled recovery protection');
      const untitledId = [...native.recoverySnapshots.keys()].find((id) => id !== independentId)!;
      click('[role="tab"][aria-selected="true"] .tab-close');
      await until(
        () => document.querySelector('#close-document-title'),
        'untitled close confirmation',
      );
      button('放弃');
      await until(
        () => tabPaths().length === 1 && !native.recoverySnapshots.has(untitledId),
        'discarded untitled cleanup',
      );
      await observe(650);
      check(
        (settings.get('document-session') as SavedDocumentSession).documents
          .map((entry) => entry.path)
          .join('|') === filePath('a'),
        'A discarded untitled tab remained in session metadata',
      );
      check(
        native.recoverySnapshots.has(independentId),
        'Untitled discard cleared another pending draft',
      );
      return `${testCase}: discarded untitled tab omitted, its journal cleared, independent draft retained`;
    }
    await until(
      () =>
        (settings.get('document-session') as SavedDocumentSession).documents.every(
          (entry) => !!entry.place,
        ),
      'complete baseline session positions',
    );
    const baseline = structuredClone(settings.get('document-session')) as SavedDocumentSession;
    const first = await sourceField();
    check(first.value.startsWith('# Latest A'), 'The first edit targeted a different document');
    prepend(first, 'First unsaved change\n');
    await until(() => first.value.startsWith('First unsaved change\n'), 'first dirty source');
    await selectFile('b');
    const second = await sourceField();
    check(
      second !== first && second.value.startsWith('# Latest B'),
      'The second edit did not target its own document',
    );
    prepend(second, 'Second unsaved change\n');
    await until(() => second.value.startsWith('Second unsaved change\n'), 'second dirty source');
    await selectFile('a');
    click('button[aria-label="关闭窗口"]');
    await until(
      () => document.querySelector('#close-document-title')?.textContent?.includes('a.md'),
      'first close confirmation',
    );
    button('放弃');
    await until(
      () => document.querySelector('#close-document-title')?.textContent?.includes('b.md'),
      'second close confirmation',
    );
    button('取消');
    await observe(750);
    const persisted = settings.get('document-session') as SavedDocumentSession;
    check(
      persisted.documents.map((entry) => entry.path).join('|') ===
        baseline.documents.map((entry) => entry.path).join('|'),
      'Cancelling window close committed the shortened runtime queue',
    );
    check(
      !native.calls.some((call) => call.command === 'plugin:window|destroy') &&
        tabPaths().join('|') === filePath('b'),
      'Cancelled window close destroyed the window or removed the remaining draft',
    );
    check(
      files.get(filePath('a'))?.startsWith('# Latest A'),
      'Discarding during exit overwrote the saved disk body',
    );
    return `${testCase}: complete session frozen through discard/cancel, remaining draft retained`;
  } finally {
    releaseRetry();
    root.unmount();
    host.remove();
  }
}
