import { createRoot } from 'react-dom/client';
import { createNativeMocks } from './nativeMocks';
import App from '../../src/App';
import { StatusBar } from '../../src/components/StatusBar';
import { DEFAULT_SHORTCUTS } from '../../src/lib/shortcuts';
import type { Tab } from '../../src/lib/types';
import { version as packageVersion } from '../../package.json';
import { longDocument } from './continuity';
import { typographyDocument } from './typography';
import { checkTabSwitches, installTabSwitchMocks } from './tabSwitch';
import { runWindowOpenRegression, windowOpenCases, type WindowOpenCase } from './windowOpen';
import '../../src/styles/global.css';

export const interfaceCases = [
  'interface-presence',
  'interface-rapid-reopen',
  'interface-exit-keyboard',
  'interface-reduced-motion',
  'interface-navigation-scroll',
  'interface-tab-scroll',
  'interface-tab-scroll-reduced',
  'interface-tab-switch-rich',
  'interface-tab-switch-source',
  'interface-search-source',
  'interface-search-rich',
  'interface-search-mode-switch',
  'interface-layout-1440-900',
  'interface-layout-1100-768',
  'interface-layout-1024-768',
  'interface-layout-840-700',
  'interface-layout-800-600',
  'interface-layout-480-700',
  'interface-layout-390-844',
  'interface-layout-360-640',
  'interface-layout-320-640',
  'interface-statusbar-clipping',
  'window-open-delayed-recents',
  'window-open-delayed-preferences',
  'window-open-delayed-file',
  'window-open-error-after-show',
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
function inViewport(element: Element, label: string, box = element.getBoundingClientRect()) {
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
function visibleRect(
  element: HTMLElement,
  box: DOMRectReadOnly = element.getBoundingClientRect(),
  clipSelf = false,
): DOMRect {
  let left = Math.max(0, box.left);
  let top = Math.max(0, box.top);
  let right = Math.min(innerWidth, box.right);
  let bottom = Math.min(innerHeight, box.bottom);
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      return new DOMRect(left, top, 0, 0);
    if (ancestor === element && !clipSelf) continue;
    const bounds = ancestor.getBoundingClientRect();
    const scaleX = ancestor.offsetWidth ? bounds.width / ancestor.offsetWidth : 1;
    const scaleY = ancestor.offsetHeight ? bounds.height / ancestor.offsetHeight : 1;
    const clientLeft = bounds.left + ancestor.clientLeft * scaleX;
    const clientTop = bounds.top + ancestor.clientTop * scaleY;
    if (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX)) {
      left = Math.max(left, clientLeft);
      right = Math.min(right, clientLeft + ancestor.clientWidth * scaleX);
    }
    if (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowY)) {
      top = Math.max(top, clientTop);
      bottom = Math.min(bottom, clientTop + ancestor.clientHeight * scaleY);
    }
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
function checkReadableText(element: HTMLElement, text: string, label: string) {
  const start = element.textContent?.indexOf(text) ?? -1;
  check(start >= 0, `${label}: critical text is missing: ${text}`);
  const style = getComputedStyle(element);
  let textLeft = -Infinity;
  let textRight = Infinity;
  if (style.textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + 1) {
    const marker = document.createElement('span');
    marker.textContent = '…';
    marker.style.cssText = 'position:fixed;visibility:hidden;white-space:pre;width:max-content';
    marker.style.font = style.font;
    marker.style.letterSpacing = style.letterSpacing;
    document.body.append(marker);
    const markerWidth = marker.getBoundingClientRect().width;
    marker.remove();
    const bounds = element.getBoundingClientRect();
    const scale = element.offsetWidth ? bounds.width / element.offsetWidth : 1;
    const clientLeft = bounds.left + element.clientLeft * scale;
    if (style.direction === 'rtl')
      textLeft = clientLeft + ((parseFloat(style.paddingLeft) || 0) + markerWidth) * scale;
    else
      textRight =
        clientLeft +
        (element.clientWidth - (parseFloat(style.paddingRight) || 0) - markerWidth) * scale;
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let measured = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const content = node.textContent ?? '';
    for (
      let index = Math.max(0, start - offset);
      index < content.length && offset + index < start + text.length;
      index++
    ) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const boxes = Array.from(range.getClientRects());
      check(boxes.length > 0, `${label}: critical text has no visible glyph: ${text}`);
      for (const box of boxes) {
        const visible = visibleRect(node.parentElement!, box, true);
        const geometry = JSON.stringify({
          raw: box.toJSON(),
          visible: visible.toJSON(),
          textLeft,
          textRight,
        });
        check(
          visible.width > 0 &&
            visible.height > 0 &&
            box.left >= Math.max(visible.left, textLeft) - 0.5 &&
            box.right <= Math.min(visible.right, textRight) + 0.5 &&
            box.top >= visible.top - 0.5 &&
            box.bottom <= visible.bottom + 0.5,
          `${label}: critical text is clipped: ${text} (${content[index]}): ${geometry}`,
        );
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        check(
          hit && element.contains(hit),
          `${label}: critical text is covered: ${text} (${content[index]}): ${geometry}`,
        );
      }
      measured++;
    }
    offset += content.length;
  }
  check(measured === text.length, `${label}: critical text was not fully measured: ${text}`);
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
  ]
    .map((element) => {
      const box = visibleRect(element);
      if (element.matches('.status-save-paused, .status-recovery.recovery-status-error'))
        check(
          box.width > 0 && box.height > 0,
          `${label}: critical feedback has no visible area: ${element.className}: ${JSON.stringify({ raw: element.getBoundingClientRect().toJSON(), visible: box.toJSON() })}`,
        );
      return { element, box };
    })
    .filter(({ box }) => box.width > 0 && box.height > 0);
  for (const { element, box } of items) inViewport(element, `${label}: ${element.className}`, box);
  for (let first = 0; first < items.length; first++) {
    const before = items[first].box;
    for (const after of items.slice(first + 1)) {
      const box = after.box;
      const overlapWidth = Math.min(before.right, box.right) - Math.max(before.left, box.left);
      const overlapHeight = Math.min(before.bottom, box.bottom) - Math.max(before.top, box.top);
      check(
        overlapWidth <= 0.5 || overlapHeight <= 0.5,
        `${label}: status bar items overlap: ${items[first].element.className} / ${after.element.className}: ${JSON.stringify({ first: before.toJSON(), second: box.toJSON() })}`,
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
    await until(() => document.querySelector('.statusbar-zoom')?.textContent?.trim() === '100%');
    check(
      document.querySelector<HTMLElement>('.editor-tab.active .milkdown')?.style.zoom === '1',
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
  const display = `D:\\notes\\${'用于状态栏布局验证的较长目录\\'.repeat(8)}document-with-a-long-name.md`;
  const path = `\\\\?\\${display}`;
  const tab: Tab = {
    id: 'statusbar-layout',
    title: 'document-with-a-long-name.md',
    path,
    isNew: false,
    dirty: true,
    diskMtime: 0,
    diskRevision: 'statusbar-fixture-revision',
    externalChanged: true,
    initialContent: '# Saved draft',
    savedContent: '# Saved draft',
    markdown: '# Local draft',
    stats: { words: 1234567890, chars: 9876543210, lines: 123456789 },
  };
  const calls: string[] = [];
  localStorage.setItem('mdplus-editor-zoom', '200');
  root.render(
    <div className="app" data-body-font="misans" data-statusbar-fixture="true">
      <main className="editor-area" />
      <StatusBar
        bindings={DEFAULT_SHORTCUTS}
        tab={tab}
        themeMode="light"
        onThemeMode={(mode) => {
          calls.push(`theme:${mode}`);
        }}
        sourceMode={true}
        saveState="paused"
        editorAreaRef={{ current: null }}
        bodyFont="misans"
        codeFont="jetbrains-sarasa"
        onBodyFont={() => {}}
        onCodeFont={() => {}}
        editorWidth="centered"
        onEditorWidth={() => {}}
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
  for (const [selector, text] of [
    ['.status-save-paused', '自动保存已暂停'],
    ['.status-recovery.recovery-status-error', '恢复副本失败'],
  ]) {
    const feedback = document.querySelector<HTMLElement>(selector);
    check(
      feedback && feedback.textContent?.trim(),
      `${label}: critical save/recovery feedback is missing`,
    );
    check(
      feedback.getAttribute('role') === 'status',
      `${label}: critical feedback lacks status semantics`,
    );
    checkReadableText(feedback, text, `${label}: ${selector}`);
    hitTarget(feedback, `${label}: ${selector}`);
    check(
      feedback.title.includes('Ctrl+S') && /保存|另存为/.test(feedback.title),
      `${label}: critical feedback lacks a manual save instruction`,
    );
  }
  const identity = document.querySelector<HTMLElement>('.status-file-identity');
  check(
    identity?.textContent === display && identity.title === display,
    `${label}: long path identity was discarded or exposes the internal Windows prefix`,
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
    calls.join('|') === 'recovery|theme:dark' &&
      localStorage.getItem('mdplus-editor-zoom') === '100',
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
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await until(() => document.querySelector('.editor-tab.active .ProseMirror'));
  click('button[aria-label="切换 Markdown 模式"]');
  await until(() => document.querySelector('.source-editor:not([hidden]) textarea'));
  const source = document.querySelector<HTMLTextAreaElement>(
    '.source-editor:not([hidden]) textarea',
  )!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(source, text);
  source.dispatchEvent(new Event('input', { bubbles: true }));
  await frame();
  source.setSelectionRange(0, 0);
  source.scrollTop = 0;
  click('button[aria-label="切换 Markdown 模式"]');
  await until(() => !document.querySelector('.source-editor:not([hidden])'));
  await document.fonts.ready;
  await settled();
  return source;
}

function checkClippingRegression() {
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:20px;top:20px;width:120px;height:100px;box-sizing:border-box;border:4px solid black;padding:6px;overflow:hidden;background:white;color:black;z-index:2147483647';
  const auxiliary = document.createElement('span');
  auxiliary.style.cssText = 'position:absolute;left:80px;top:60px;width:160px;height:20px';
  const action = document.createElement('button');
  action.style.cssText = 'position:fixed;left:160px;top:84px;width:20px;height:20px';
  const feedback = document.createElement('span');
  feedback.style.cssText =
    'position:absolute;left:6px;top:6px;width:max-content;white-space:nowrap;font:14px monospace';
  feedback.textContent = '自动保存已暂停';
  host.append(auxiliary, feedback);
  document.body.append(host, action);
  const overlaps = (before: DOMRectReadOnly, after: DOMRectReadOnly) =>
    Math.min(before.right, after.right) - Math.max(before.left, after.left) > 0.5 &&
    Math.min(before.bottom, after.bottom) - Math.max(before.top, after.top) > 0.5;
  const expectClipped = (label: string) => {
    let message = '';
    try {
      checkReadableText(feedback, '自动保存已暂停', label);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    check(
      message.includes('critical text is clipped'),
      `${label}: critical clipping was not rejected: ${message}`,
    );
  };
  try {
    check(
      overlaps(auxiliary.getBoundingClientRect(), action.getBoundingClientRect()),
      'Controlled fixture did not reproduce raw overlap',
    );
    check(
      !overlaps(visibleRect(auxiliary), visibleRect(action)),
      'Clipped auxiliary still produces visible overlap',
    );
    host.style.width = '260px';
    check(
      overlaps(visibleRect(auxiliary), visibleRect(action)),
      'Genuine visible overlap was incorrectly removed',
    );
    checkReadableText(feedback, '自动保存已暂停', 'fully readable feedback');
    const textWidth = feedback.getBoundingClientRect().width;
    host.style.width = `${Math.floor(textWidth * 0.75) + 14}px`;
    hitTarget(feedback, 'partially clipped feedback with a hittable raw center');
    expectClipped('essential suffix clipped by ancestor');
    host.style.width = '260px';
    feedback.style.width = `${Math.floor(textWidth * 0.75)}px`;
    feedback.style.overflow = 'hidden';
    feedback.style.textOverflow = 'ellipsis';
    expectClipped('essential suffix ellipsized by feedback itself');
    feedback.textContent = '自动保存已暂停' + ' · Ctrl+S'.repeat(5);
    feedback.style.width = `${textWidth}px`;
    expectClipped('ellipsis marker covers otherwise unclipped essential suffix');
    feedback.style.width = `${textWidth + 24}px`;
    checkReadableText(feedback, '自动保存已暂停', 'only redundant instructions are ellipsized');
    feedback.style.left = '400px';
    expectClipped('fully clipped critical feedback');
    check(
      visibleRect(feedback).width === 0,
      'Fully clipped critical feedback retains visible width',
    );
    host.style.width = '80px';
    check(visibleRect(auxiliary).width === 0, 'Fully clipped auxiliary retains visible width');
  } finally {
    host.remove();
    action.remove();
  }
}
export async function runInterfaceRegression(testCase: InterfaceCase): Promise<string> {
  if (testCase === 'interface-statusbar-clipping') {
    await document.fonts.ready;
    checkClippingRegression();
    return `${testCase}: passed (controlled ancestor/self clipping, text ranges and genuine overlap)`;
  }
  if (windowOpenCases.includes(testCase as WindowOpenCase))
    return runWindowOpenRegression(testCase as WindowOpenCase);
  const switching =
    testCase === 'interface-tab-switch-rich' || testCase === 'interface-tab-switch-source';
  if (switching) installTabSwitchMocks();
  else createNativeMocks().install();
  localStorage.removeItem('mdplus-body-font');
  localStorage.removeItem('mdplus-editor-font');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(<App />);
  try {
    await until(() => document.querySelector('button[title="新建文档 (Ctrl+N)"]'));
    if (switching) {
      return await checkTabSwitches(testCase === 'interface-tab-switch-source');
    } else if (testCase === 'interface-search-mode-switch') {
      const source = await openDocument('# Search\n\nNeedle **needle** Needle\n');
      const original = source.value;
      click('button[aria-label="切换 Markdown 模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden]) textarea'));
      click('button[aria-label="搜索当前文档"]');
      await until(() => document.querySelector('.search-input'));
      const input = document.querySelector<HTMLInputElement>('.search-input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Needle',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await until(() => document.querySelector('.search-count')?.textContent === '3 处');
      click('.search-case input');
      await until(() => document.querySelector('.search-count')?.textContent === '2 处');

      click('button[aria-label="切换 Markdown 模式"]');
      await until(() => !document.querySelector('.source-editor:not([hidden])'));
      await until(
        () =>
          document.querySelector('.search-count')?.textContent === '2 处' &&
          document.querySelector('.editor-tab.active .md-search-current')?.textContent === 'Needle',
      );
      await settled();

      check(input.value === 'Needle', 'Mode switching cleared the active search query');
      check(
        document.querySelector<HTMLInputElement>('.search-case input')?.checked,
        'Mode switching cleared the case-sensitive preference',
      );
      check(
        document.querySelector('.search-count')?.textContent === '2 处',
        'Rendered search did not reapply the source query after mode switching',
      );
      const firstMatch = document.querySelector('.editor-tab.active .md-search-current');
      check(firstMatch?.textContent === 'Needle', 'Rendered search is missing its initial match');
      click('button[aria-label="下一条匹配"]');
      await settled();
      const nextMatch = document.querySelector('.editor-tab.active .md-search-current');
      check(
        nextMatch?.textContent === 'Needle' && nextMatch !== firstMatch,
        'Rendered search cannot navigate the retained query',
      );
      check(source.value === original, 'Searching across modes changed the source Markdown');
      click('button[aria-label="关闭搜索"]');
      await until(() => !document.querySelector('.searchbar'));
      check(
        document.activeElement === document.querySelector('.editor-tab.active .ProseMirror'),
        'Closing search after mode switching did not restore rendered editor focus',
      );
      check(
        document.getSelection()?.toString() === 'Needle',
        'Closing search did not restore the selected occurrence along with editor focus',
      );
    } else if (testCase === 'interface-search-source' || testCase === 'interface-search-rich') {
      const source = await openDocument('# Search\n\nhello **world**\n');
      const sourceCase = testCase === 'interface-search-source';
      const query = sourceCase ? 'source+[marker]' : 'hello world';
      if (sourceCase) {
        click('button[aria-label="切换 Markdown 模式"]');
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
      await until(() => document.querySelector('.search-count')?.textContent === '1 处');
      await settled();
      check(
        document.querySelector('.search-count')?.textContent === '1 处',
        'Search did not count the current visible text',
      );
      const writing = sourceCase
        ? source
        : document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
      writing.focus({ preventScroll: true });
      writing.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      await frame();
      check(
        input.value === query &&
          document.activeElement === input &&
          document.querySelectorAll('.searchbar').length === 1,
        'Repeated Ctrl+F must preserve the query and return focus to search',
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
        await until(() => document.querySelector('.search-count')?.textContent === '无匹配');
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
      click('button[title="新建文档 (Ctrl+N)"]');
      await until(() => document.querySelector('.editor-tab.active .ProseMirror'));
      await until(() => document.activeElement?.getAttribute('aria-label') === '文档正文');
      check(!document.querySelector('[role="dialog"]'), 'New document still requires a chooser');
      click('.tab-close');
      await until(() => document.querySelector('.welcome'));
      check(
        !document.querySelector('#close-document-title'),
        'Untouched blank document needs confirmation',
      );
      const trigger = document.querySelector<HTMLElement>('button[aria-label="恢复草稿"]')!;
      click('button[aria-label="恢复草稿"]');
      await until(() => document.querySelector('.recovery-modal'));
      const modal = document.querySelector<HTMLElement>('.recovery-modal')!;
      await settled();
      click('.recovery-modal > .modal-actions button');
      await until(() => modal.closest('[inert]') || !modal.isConnected);
      check(
        modal.isConnected && modal.closest('[inert][aria-hidden="true"]'),
        'Closing dialog was removed early or still accepts input',
      );
      check(document.activeElement === trigger, 'Dialog exit delayed focus restoration');
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
      click('button[aria-label="更多文件操作"]');
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
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await until(() => document.querySelector('.editor-tab.active .ProseMirror'));
        await until(() => document.querySelectorAll('[role="tab"]').length === count);
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
      check(
        calls.length === 1 && calls[0].behavior === 'instant',
        'Keyboard tab selection must reveal the target once before its first display frame',
      );
      const target = calls[0].left!;
      check(
        target > 100 && document.activeElement === last,
        'Keyboard did not select and focus the offscreen tab',
      );
      check(
        positions[0] === 0 && focusStability.length === 1 && focusStability[0],
        'Tab focus scrolled independently of the explicit navigation',
      );
      check(
        Math.abs(strip.scrollLeft - target) < 2 &&
          tabs[tabs.length - 1].getBoundingClientRect().right <=
            strip.getBoundingClientRect().right + 1,
        'Active tab was clipped in its first display frame',
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
        document.querySelector<HTMLElement>('.editor-tab.active .milkdown')!.style.zoom =
          String(zoom);
        check(
          document.documentElement.scrollWidth <= width,
          `App overflows at ${zoom * 100}% editor zoom`,
        );
        inViewport(document.querySelector('.status-save')!, 'Save state');
        checkStatusbarLayout(`${width}x${height}: document at ${zoom * 100}% zoom`, true);
      }
      document.querySelector<HTMLElement>('.editor-tab.active .milkdown')!.style.zoom = '1';
      const toolbar = document.querySelector('.toolbar')!.getBoundingClientRect();
      for (const button of document.querySelectorAll('.toolbar button')) {
        const box = button.getBoundingClientRect();
        if (box.width) {
          inViewport(button, button.getAttribute('title') ?? 'Toolbar control');
          check(
            box.top >= toolbar.top - 1 && box.bottom <= toolbar.bottom + 1,
            'Toolbar control overlaps the tab strip or leaves its header',
          );
        }
      }
      const imageButton = document.querySelector('.toolbar-insert-image')!;
      const imagePicker = imageButton.getBoundingClientRect();
      check(
        imagePicker.width >= 44 && imagePicker.height >= 44,
        'Image picker target is too small',
      );
      const imageIcon = imageButton.querySelector('svg')!.getBoundingClientRect();
      const fileActions = Array.from(
        document.querySelectorAll('.toolbar-file-actions .toolbar-btn'),
      );
      for (const action of fileActions) {
        const box = action.getBoundingClientRect();
        const icon = action.querySelector('svg')!.getBoundingClientRect();
        check(
          Math.abs(box.top - imagePicker.top) < 0.5 && box.height === imagePicker.height,
          'File actions do not share one aligned hit area',
        );
        check(icon.width === 16 && icon.height === 16, 'File-action icons use different grids');
        check(
          Math.abs(icon.top + icon.height / 2 - imageIcon.top - imageIcon.height / 2) < 0.5,
          'File-action icon centers disagree',
        );
      }
      const label = imageButton.querySelector('.toolbar-btn-label')!.getBoundingClientRect();
      if (!label.width)
        check(
          Math.abs(
            imageIcon.left + imageIcon.width / 2 - imagePicker.left - imagePicker.width / 2,
          ) < 1,
          'Compact image icon is not centered in its button',
        );
      for (const icon of document.querySelectorAll('.toolbar-file-actions button > svg')) {
        const box = icon.getBoundingClientRect();
        check(
          Math.abs(box.top + box.height / 2 - imageIcon.top - imageIcon.height / 2) < 1,
          'File action icons do not share a vertical center',
        );
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
      check(
        options[1].getBoundingClientRect().top >= options[0].getBoundingClientRect().bottom,
        'Font options are not stacked for readable comparison',
      );
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
      click('button[aria-label="搜索当前文档"]');
      await until(() => document.querySelector('.searchbar'));
      click('button[aria-label="显示替换"]');
      await until(() => document.querySelector('.search-replace-input'));
      await settled();
      inViewport(document.querySelector('.searchbar')!, 'Search and replace panel');
      for (const field of document.querySelectorAll('.search-input, .search-replace-input')) {
        hitTarget(field as HTMLElement, field.getAttribute('aria-label')!);
        check(field.getBoundingClientRect().width >= 80, 'Search text field is too narrow');
      }
      if (width <= 460) {
        const heading = document.querySelector('.editor-tab.active .ProseMirror h1')!;
        check(
          heading.getBoundingClientRect().bottom <=
            document.querySelector('.searchbar')!.getBoundingClientRect().top,
          'Narrow search panel covers the beginning of the document',
        );
      }
      click('button[aria-label="关闭搜索"]');
      await until(() => !document.querySelector('.searchbar'));
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
