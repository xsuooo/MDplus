import { createRoot } from 'react-dom/client';
import { createNativeMocks } from './nativeMocks';
import App from '../../src/App';
import { StatusBar } from '../../src/components/StatusBar';
import type { Tab } from '../../src/lib/types';
import { version as packageVersion } from '../../package.json';
import { longDocument } from './continuity';
import { typographyDocument } from './typography';
import '../../src/styles/global.css';

export const interfaceCases = [
  'interface-presence',
  'interface-rapid-reopen',
  'interface-exit-keyboard',
  'interface-reduced-motion',
  'interface-navigation-scroll',
  'interface-tab-scroll',
  'interface-tab-scroll-reduced',
  'interface-search-source',
  'interface-search-rich',
  'interface-layout-1440-900',
  'interface-layout-1100-768',
  'interface-layout-1024-768',
  'interface-layout-840-700',
  'interface-layout-800-600',
  'interface-layout-480-700',
  'interface-layout-390-844',
  'interface-layout-360-640',
  'interface-layout-320-640',
] as const;
export type InterfaceCase = (typeof interfaceCases)[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => unknown) {
  const end = performance.now() + 15000;
  while (!condition()) {
    check(performance.now() < end, 'Interface regression timed out');
    await frame();
  }
}
function click(selector: string) {
  const button = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
    (element) => !element.closest('[inert]'),
  );
  check(button, `Missing interactive control: ${selector}`);
  button.focus({ preventScroll: true });
  button.click();
}
async function settled() {
  await frame();
  await frame();
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => {})),
  );
}
function inViewport(element: Element, label: string) {
  const box = element.getBoundingClientRect();
  check(
    box.width > 0 &&
      box.height > 0 &&
      box.left >= -1 &&
      box.top >= -1 &&
      box.right <= innerWidth + 1 &&
      box.bottom <= innerHeight + 1,
    `${label} is outside the viewport: ${JSON.stringify(box.toJSON())}`,
  );
}
function hitTarget(element: HTMLElement, label: string) {
  inViewport(element, label);
  const box = element.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  check(hit && element.contains(hit), `${label} is clipped or covered by another element`);
}
function statusbarButton(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(`.statusbar-actions ${selector}`);
  check(button, `Missing status bar action: ${selector}`);
  check(
    !button.disabled && button.getAttribute('aria-disabled') !== 'true',
    `${selector} is disabled`,
  );
  hitTarget(button, button.getAttribute('aria-label') ?? selector);
  button.focus({ preventScroll: true });
  check(document.activeElement === button, `Status bar action cannot receive focus: ${selector}`);
  return button;
}
function checkStatusbarLayout(label: string, hasDocument: boolean) {
  const bar = document.querySelector<HTMLElement>('.statusbar')!;
  check(bar, `${label}: status bar is missing`);
  inViewport(bar, `${label}: status bar`);
  check(bar.scrollWidth <= bar.clientWidth + 1, `${label}: status bar has horizontal overflow`);
  const version = bar.querySelector<HTMLElement>('.statusbar-version');
  check(version, `${label}: version is missing`);
  check(
    version.textContent?.trim() === `v${packageVersion}`,
    `${label}: displayed version is stale`,
  );
  check(
    version.title.includes(packageVersion) && version.getAttribute('aria-label') === version.title,
    `${label}: version lacks accessible build details`,
  );
  hitTarget(version, `${label}: version`);
  check(version.scrollWidth <= version.clientWidth + 1, `${label}: version text is truncated`);
  version.focus({ preventScroll: true });
  check(
    version.tabIndex >= 0 && document.activeElement === version,
    `${label}: version is not focusable`,
  );
  const buttons = Array.from(
    bar.querySelectorAll<HTMLButtonElement>('.statusbar-actions .statusbar-theme'),
  );
  check(buttons.length === (hasDocument ? 4 : 3), `${label}: status bar actions are incomplete`);
  for (const button of buttons) {
    check(
      button.getAttribute('aria-label'),
      `${label}: a status bar action has no accessible name`,
    );
    statusbarButton(`[aria-label="${button.getAttribute('aria-label')}"]`);
  }
  const items = [
    ...bar.querySelectorAll<HTMLElement>(
      '.status-save, .status-recovery, .statusbar-details, .statusbar-location',
    ),
    ...buttons,
    version,
  ].filter((element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  for (const item of items) inViewport(item, `${label}: ${item.className}`);
  for (let first = 0; first < items.length; first++) {
    const before = items[first].getBoundingClientRect();
    for (const after of items.slice(first + 1)) {
      const box = after.getBoundingClientRect();
      const overlapWidth = Math.min(before.right, box.right) - Math.max(before.left, box.left);
      const overlapHeight = Math.min(before.bottom, box.bottom) - Math.max(before.top, box.top);
      check(
        overlapWidth <= 0.5 || overlapHeight <= 0.5,
        `${label}: status bar items overlap: ${items[first].className} / ${after.className}`,
      );
    }
  }
}
async function checkAppStatusbar(label: string, hasDocument: boolean) {
  await document.fonts.ready;
  await settled();
  checkStatusbarLayout(label, hasDocument);
  statusbarButton('button[aria-label="恢复草稿"]').click();
  await until(() => document.querySelector('.recovery-modal'));
  click('.recovery-modal > .modal-actions button');
  await until(() => !document.querySelector('.recovery-modal'));
  statusbarButton('button[aria-label="排版设置"]').click();
  await until(() => document.querySelector('.typography-panel'));
  click('button[aria-label="关闭排版设置"]');
  await until(() => !document.querySelector('.typography-panel'));
  if (hasDocument) {
    statusbarButton('.statusbar-zoom').click();
    check(
      document.querySelector('.statusbar-zoom')?.textContent?.trim() === '100%',
      `${label}: zoom reset failed`,
    );
  }
  const theme = statusbarButton('button[aria-label^="切换主题"]');
  const before = theme.getAttribute('aria-label');
  theme.click();
  await until(
    () =>
      document
        .querySelector('.statusbar-actions button[aria-label^="切换主题"]')
        ?.getAttribute('aria-label') !== before,
  );
  await settled();
  checkStatusbarLayout(label, hasDocument);
}
async function checkCrowdedStatusbar(root: ReturnType<typeof createRoot>, label: string) {
  const path = `D:/notes/${'用于状态栏布局验证的较长目录/'.repeat(8)}document-with-a-long-name.md`;
  const tab: Tab = {
    id: 'statusbar-layout',
    title: 'document-with-a-long-name.md',
    path,
    isNew: false,
    dirty: true,
    externalMtime: 0,
    diskRevision: 'statusbar-fixture-revision',
    externalChanged: true,
    initialContent: '# Saved draft',
    savedContent: '# Saved draft',
    markdown: '# Local draft',
    stats: { words: 1234567890, chars: 9876543210, lines: 123456789 },
  };
  const calls: string[] = [];
  root.render(
    <div className="app" data-body-font="misans" data-statusbar-fixture="true">
      <main className="editor-area" />
      <StatusBar
        tab={tab}
        themeMode="light"
        onThemeMode={(mode) => {
          calls.push(`theme:${mode}`);
        }}
        sourceMode={true}
        saveState="paused"
        zoom={200}
        onResetZoom={() => {
          calls.push('zoom');
        }}
        bodyFont="misans"
        codeFont="jetbrains-sarasa"
        onBodyFont={() => {}}
        onCodeFont={() => {}}
        recoveryStatus="error"
        onRecovery={() => {
          calls.push('recovery');
        }}
      />
    </div>,
  );
  await until(() => document.querySelector('[data-statusbar-fixture]'));
  await document.fonts.ready;
  await settled();
  checkStatusbarLayout(`${label}: paused save and recovery error`, true);
  for (const selector of ['.status-save-paused', '.status-recovery.recovery-status-error']) {
    const feedback = document.querySelector<HTMLElement>(selector);
    check(
      feedback && feedback.textContent?.trim(),
      `${label}: critical save/recovery feedback is missing`,
    );
    hitTarget(feedback, `${label}: ${selector}`);
    check(
      feedback.title.includes('Ctrl+S'),
      `${label}: critical feedback lacks a manual save instruction`,
    );
  }
  const identity = document.querySelector<HTMLElement>('.status-file-identity');
  check(
    identity?.textContent === path && identity.title === path,
    `${label}: long path identity was discarded`,
  );
  for (const [selector, value] of [
    ['.status-metric-words', '1234567890'],
    ['.status-metric-chars', '9876543210'],
    ['.status-metric-lines', '123456789'],
  ]) {
    check(
      document.querySelector(selector)?.textContent?.includes(value),
      `${label}: large statistics were lost`,
    );
  }
  statusbarButton('button[aria-label="恢复草稿"]').click();
  statusbarButton('.statusbar-zoom').click();
  statusbarButton('button[aria-label^="切换主题"]').click();
  check(
    calls.join('|') === 'recovery|zoom|theme:dark',
    `${label}: an action missed or invoked the wrong handler`,
  );
  statusbarButton('button[aria-label="排版设置"]').click();
  await until(() => document.querySelector('.typography-panel'));
  click('button[aria-label="关闭排版设置"]');
  await until(() => !document.querySelector('.typography-panel'));
  await settled();
  checkStatusbarLayout(`${label}: after crowded actions`, true);
}
async function openDocument(text: string) {
  click('button[title="新建文档 (Ctrl+N)"]');
  await until(() => document.querySelector('.newfile-card'));
  click('.newfile-card');
  await until(() => document.querySelector('.editor-tab.active .ProseMirror'));
  await until(() => !document.querySelector('.newfile-modal'));
  click('button[aria-label="切换源码模式"]');
  await until(() => document.querySelector('.source-editor:not([hidden]) textarea'));
  const source = document.querySelector<HTMLTextAreaElement>(
    '.source-editor:not([hidden]) textarea',
  )!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(source, text);
  source.dispatchEvent(new Event('input', { bubbles: true }));
  await frame();
  source.setSelectionRange(0, 0);
  source.scrollTop = 0;
  click('button[aria-label="切换源码模式"]');
  await until(() => !document.querySelector('.source-editor:not([hidden])'));
  await document.fonts.ready;
  await settled();
  return source;
}

export async function runInterfaceRegression(testCase: InterfaceCase): Promise<string> {
  createNativeMocks().install();
  localStorage.removeItem('mdplus-body-font');
  localStorage.removeItem('mdplus-editor-font');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(<App />);
  try {
    await until(() => document.querySelector('button[title="新建文档 (Ctrl+N)"]'));
    if (testCase === 'interface-search-source' || testCase === 'interface-search-rich') {
      const source = await openDocument('# Search\n\nhello **world**\n');
      const sourceCase = testCase === 'interface-search-source';
      const query = sourceCase ? 'source+[marker]' : 'hello world';
      if (sourceCase) {
        click('button[aria-label="切换源码模式"]');
        await until(() => document.querySelector('.source-editor:not([hidden]) textarea'));
        const latest =
          Array.from({ length: 60 }, (_, index) => `Line ${index}`).join('\n') + `\n${query}\n`;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          source,
          latest,
        );
        source.dispatchEvent(new Event('input', { bubbles: true }));
        await frame();
        source.scrollTop = 0;
      }
      const original = source.value;
      click('button[aria-label="搜索当前文档"]');
      await until(() => document.querySelector('.search-input'));
      const input = document.querySelector<HTMLInputElement>('.search-input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settled();
      check(
        document.querySelector('.search-count')?.textContent === '1 处',
        'Search did not count the current visible text',
      );
      click('button[aria-label="下一条匹配"]');
      await settled();
      if (sourceCase) {
        check(
          source.value.slice(source.selectionStart, source.selectionEnd) === query,
          'Search did not select the current source occurrence',
        );
        check(source.scrollTop > 0, 'Source match remained outside the visible source viewport');
        check(
          !document.querySelector('.editor-tab.active .md-search-current'),
          'Source search changed the hidden rendered selection',
        );
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          source,
          original.replace(query, 'removed'),
        );
        source.dispatchEvent(new Event('input', { bubbles: true }));
        await settled();
        check(
          document.querySelector('.search-count')?.textContent === '无匹配',
          'Source search retained a stale count after editing',
        );
      } else {
        const matched = Array.from(
          document.querySelectorAll('.md-search-current'),
          (element) => element.textContent,
        ).join('');
        check(matched === query, 'Search lost part of a phrase across bold formatting');
        check(source.value === original, 'Search rewrote source Markdown');
      }
    } else if (testCase === 'interface-presence') {
      const trigger = document.querySelector<HTMLElement>('button[title="新建文档 (Ctrl+N)"]')!;
      click('button[title="新建文档 (Ctrl+N)"]');
      await until(() => document.querySelector('.newfile-modal'));
      const modal = document.querySelector<HTMLElement>('.newfile-modal')!;
      await settled();
      click('.newfile-modal .modal-actions button');
      await frame();
      check(
        modal.isConnected && modal.closest('[inert][aria-hidden="true"]'),
        'Closing dialog was removed early or still accepts input',
      );
      check(document.activeElement === trigger, 'Dialog exit delayed focus restoration');
      modal.querySelector<HTMLButtonElement>('.newfile-card')!.click();
      await frame();
      check(!document.querySelector('[role="tab"]'), 'Exiting dialog accepted a second action');
      await until(() => !modal.isConnected);
      await openDocument(typographyDocument);
      for (const [triggerSelector, surface, closeSelector] of [
        ['button[aria-label="排版设置"]', '.typography-panel', 'button[aria-label="关闭排版设置"]'],
        ['button[aria-label="搜索当前文档"]', '.searchbar', 'button[aria-label="关闭搜索"]'],
        ['button[aria-label="打开最近文件"]', '.recent-menu', '.menu-mask'],
      ]) {
        click(triggerSelector);
        await until(() => document.querySelector(surface));
        await settled();
        const element = document.querySelector<HTMLElement>(surface)!;
        click(closeSelector);
        await frame();
        check(element.isConnected && element.closest('[inert]'), `Missing inert exit: ${surface}`);
        await until(() => !element.isConnected);
      }
      click('button[title="导出"]');
      await until(() => document.querySelector('.toolbar-dropdown-menu'));
      await settled();
      const menu = document.querySelector('.toolbar-dropdown-menu')!;
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await frame();
      check(menu.isConnected && menu.closest('[inert]'), 'Export menu has no exit lifecycle');
      await until(() => !menu.isConnected);
    } else if (testCase === 'interface-rapid-reopen') {
      click('button[aria-label="排版设置"]');
      await until(() => document.querySelector('.typography-panel'));
      await settled();
      const panel = document.querySelector('.typography-panel')!;
      for (let i = 0; i < 3; i++) {
        click('button[aria-label="排版设置"]');
        await frame();
        check(panel.closest('[inert]'), 'Panel did not begin exit');
        click('button[aria-label="排版设置"]');
        await frame();
        check(
          document.querySelectorAll('.typography-panel').length === 1 && !panel.closest('[inert]'),
          'Rapid reopen duplicated or disabled the panel',
        );
      }
      const duration = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--motion-exit'),
      );
      await new Promise((resolve) => setTimeout(resolve, duration * 2));
      check(
        panel.isConnected && document.activeElement === panel.querySelector('select'),
        'Stale exit timer removed the reopened panel or lost focus',
      );
    } else if (testCase === 'interface-exit-keyboard') {
      await openDocument(typographyDocument);
      click('button[aria-label="打开快捷键设置"]');
      await until(() => document.querySelector('.shortcut-modal'));
      const bindings = () =>
        Array.from(
          document.querySelectorAll('.shortcut-kbd-edit kbd'),
          (node) => node.textContent,
        ).join('|');
      const before = bindings();
      click('.shortcut-kbd-edit');
      await until(() => document.querySelector('.shortcut-kbd-capturing'));
      click('button[aria-label="关闭快捷键设置"]');
      await frame();
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F8', bubbles: true, cancelable: true }),
      );
      click('button[aria-label="打开快捷键设置"]');
      await frame();
      check(
        !document.querySelector('.shortcut-kbd-capturing') && bindings() === before,
        'Exiting shortcut recording swallowed a key or changed a binding',
      );
      click('button[aria-label="关闭快捷键设置"]');
      await until(() => !document.querySelector('.shortcut-modal'));
      click('button[aria-label="搜索当前文档"]');
      await until(() => document.querySelector('.search-input'));
      const input = document.querySelector<HTMLInputElement>('.search-input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '中文',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await frame();
      click('button[aria-label="关闭搜索"]');
      await frame();
      click('button[aria-label="搜索当前文档"]');
      await frame();
      check(
        input.value === '' && !document.querySelector('.md-search-hl'),
        'Quickly reopened search retained a query without its highlights',
      );
    } else if (testCase === 'interface-reduced-motion') {
      check(
        matchMedia('(prefers-reduced-motion: reduce)').matches,
        'Runner must emulate reduced motion, not only stub JavaScript',
      );
      click('button[aria-label="排版设置"]');
      await until(() => document.querySelector('.typography-panel'));
      const panel = document.querySelector('.typography-panel')!;
      check(
        getComputedStyle(panel).transform === 'none',
        'Reduced-motion panel still moves spatially',
      );
      check(
        parseFloat(getComputedStyle(panel).transitionDuration) <= 0.00001,
        'Reduced-motion CSS transition still waits',
      );
      click('button[aria-label="关闭排版设置"]');
      await frame();
      check(!panel.isConnected, 'Reduced motion retained an invisible exit delay');
      await checkNavigation(true);
    } else if (testCase === 'interface-navigation-scroll') {
      await checkNavigation(false);
    } else if (testCase === 'interface-tab-scroll' || testCase === 'interface-tab-scroll-reduced') {
      const reduced = testCase === 'interface-tab-scroll-reduced';
      check(
        matchMedia('(prefers-reduced-motion: reduce)').matches === reduced,
        'Tab scroll media preference is not emulated',
      );
      for (let count = 1; count <= 6; count++) {
        click('button[title="新建文档 (Ctrl+N)"]');
        await until(() => document.querySelector('.newfile-card'));
        click('.newfile-card');
        await until(
          () =>
            document.querySelectorAll('[role="tab"]').length === count &&
            !document.querySelector('.newfile-modal'),
        );
      }
      document.querySelector<HTMLElement>('.tabbar')!.style.width = '420px';
      const strip = document.querySelector<HTMLElement>('.tabbar-tabs')!;
      const tabs = document.querySelectorAll<HTMLElement>('[role="tab"]');
      tabs[0].focus({ preventScroll: true });
      tabs[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
      );
      await settled();
      await until(() => strip.scrollLeft === 0);
      const calls: ScrollToOptions[] = [],
        positions: number[] = [];
      const focusStability: boolean[] = [];
      const last = tabs[tabs.length - 1],
        focus = last.focus.bind(last);
      last.focus = (options) => {
        const before = strip.scrollLeft;
        focus(options);
        focusStability.push(options?.preventScroll === true && strip.scrollLeft === before);
      };
      const scrollTo = strip.scrollTo.bind(strip);
      strip.scrollTo = ((options: ScrollToOptions) => {
        positions.push(strip.scrollLeft);
        calls.push(options);
        scrollTo(options);
      }) as typeof strip.scrollTo;
      tabs[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
      );
      await frame();
      await frame();
      check(
        calls.length === 1 && calls[0].behavior === (reduced ? 'instant' : 'smooth'),
        'Keyboard tab selection must scroll once with the motion preference',
      );
      const target = calls[0].left!;
      check(
        target > 100 && document.activeElement === last,
        'Keyboard did not select and focus the offscreen tab',
      );
      // Windows can make native smooth scrolling instant; observe focus itself instead.
      check(
        positions[0] === 0 && focusStability.length === 1 && focusStability[0],
        'Tab focus scrolled independently of the explicit navigation',
      );
      await until(() => Math.abs(strip.scrollLeft - target) < 2);
      check(
        tabs[tabs.length - 1].getBoundingClientRect().right <=
          strip.getBoundingClientRect().right + 1,
        'Active tab remained clipped',
      );
    } else {
      const [width, height] = testCase.split('-').slice(-2).map(Number);
      check(
        innerWidth === width && innerHeight === height,
        `Runner viewport mismatch: ${innerWidth}x${innerHeight}`,
      );
      await until(() => document.querySelector('.welcome'));
      await checkAppStatusbar(`${width}x${height}: welcome`, false);
      const source = await openDocument(typographyDocument);
      await checkAppStatusbar(`${width}x${height}: document`, true);
      for (const zoom of [1, 2]) {
        document
          .querySelector<HTMLElement>('.editor-area')!
          .style.setProperty('--editor-zoom', String(zoom));
        check(
          document.documentElement.scrollWidth <= width,
          `App overflows at ${zoom * 100}% editor zoom`,
        );
        inViewport(document.querySelector('.status-save')!, 'Save state');
        checkStatusbarLayout(`${width}x${height}: document at ${zoom * 100}% zoom`, true);
      }
      document.querySelector<HTMLElement>('.editor-area')!.style.setProperty('--editor-zoom', '1');
      for (const button of document.querySelectorAll('.toolbar button')) {
        if (button.getBoundingClientRect().width)
          inViewport(button, button.getAttribute('title') ?? 'Toolbar control');
      }
      const original = source.value;
      click('button[aria-label="排版设置"]');
      await until(() => document.querySelector('.typography-panel'));
      await document.fonts.ready;
      await settled();
      inViewport(document.querySelector('.typography-panel')!, 'Typography panel');
      inViewport(document.querySelector('.typography-head button')!, 'Typography close');
      inViewport(document.querySelector('.typography-footer')!, 'Typography feedback');
      const content = document.querySelector<HTMLElement>('.typography-content')!;
      check(content.scrollWidth <= content.clientWidth, 'Font settings have horizontal overflow');
      const options = Array.from(document.querySelectorAll('.font-option'));
      if (width > 700) {
        check(
          Math.abs(
            options[0].getBoundingClientRect().top - options[2].getBoundingClientRect().top,
          ) < 1,
          'Desktop does not compare all three specimens in one row',
        );
      } else {
        check(
          options[1].getBoundingClientRect().top >= options[0].getBoundingClientRect().bottom,
          'Narrow font settings are not stacked',
        );
      }
      content.scrollTop = content.scrollHeight;
      await frame();
      click('input[name="code-font"][value="cascadia-misans"]');
      await document.fonts.ready;
      check(source.value === original, 'Responsive font selection edited the document');
      inViewport(document.querySelector('.typography-head button')!, 'Scrolled typography close');
      click('button[aria-label="关闭排版设置"]');
      await until(() => !document.querySelector('.typography-panel'));
      click('button[aria-label="打开快捷键设置"]');
      await until(() => document.querySelector('.shortcut-modal'));
      await settled();
      inViewport(document.querySelector('.shortcut-modal')!, 'Shortcut dialog');
      inViewport(document.querySelector('.shortcut-modal .modal-actions')!, 'Shortcut footer');
      check(
        document.querySelector('.shortcut-table-wrap')!.clientHeight > 0,
        'Shortcut content is inaccessible',
      );
      click('button[aria-label="关闭快捷键设置"]');
      await until(() => !document.querySelector('.shortcut-modal'));
      await checkCrowdedStatusbar(root, `${width}x${height}`);
    }
    return `${testCase}: passed (real DOM, CSS transitions, focus, fonts and geometry; browser-only native boundary)`;
  } finally {
    root.unmount();
    host.remove();
  }
}

async function checkNavigation(reduced: boolean) {
  const source = await openDocument(longDocument);
  const original = source.value;
  const scroller = document.querySelector<HTMLElement>('.editor-tab.active .milkdown-container')!;
  scroller.scrollTop = 0;
  click('button[aria-label="打开目录"]');
  await settled();
  const items = document.querySelectorAll<HTMLElement>('.outline-item');
  check(items.length === 35, 'Long document outline is incomplete');
  const calls: ScrollToOptions[] = [],
    positions: number[] = [];
  const scrollTo = scroller.scrollTo.bind(scroller);
  scroller.scrollTo = ((options: ScrollToOptions) => {
    positions.push(scroller.scrollTop);
    calls.push(options);
    scrollTo(options);
  }) as typeof scroller.scrollTo;
  items[17].click();
  await frame();
  await frame();
  check(
    calls.length === 1 && calls[0].behavior === (reduced ? 'instant' : 'smooth'),
    'Outline must use one preference-aware navigation scroll',
  );
  const target = calls[0].top!;
  check(positions[0] === 0, 'Outline focus scrolled before its explicit navigation');
  await until(() => Math.abs(scroller.scrollTop - target) < 2);
  check(source.value === original, 'Navigation edited the source document');
  check(
    getComputedStyle(scroller).scrollBehavior === 'auto',
    'Normal editor scrolling must not be globally smoothed',
  );
}
