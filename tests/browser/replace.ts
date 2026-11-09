import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { editorViewCtx } from '@milkdown/kit/core';
import { undo as pmUndo, redo as pmRedo, undoDepth } from '@milkdown/prose/history';
import type { Node as PMNode } from '@milkdown/prose/model';
import { createNativeMocks } from './nativeMocks';
import App from '../../src/App';
import { SearchBar } from '../../src/components/SearchBar';
import { createEditor, getCurrentState } from '../../src/lib/editor';
import { getSourceEditorApi } from '../../src/lib/sourceEditorApi';
import { searchPluginKey } from '../../src/lib/search';
import '../../src/styles/global.css';

export const replaceCases = [
  'replace-rich-format',
  'replace-rich-single',
  'replace-rich-history',
  'replace-rich-delete',
  'replace-source-history',
  'replace-source-literal',
  'replace-source-ime',
  'replace-current-document',
] as const;
export type ReplaceCase = (typeof replaceCases)[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => unknown): Promise<void> {
  const deadline = performance.now() + 12000;
  while (!condition()) {
    check(performance.now() < deadline, 'Find/replace browser regression timed out');
    await frame();
  }
}
function activeControl<T extends HTMLElement>(selector: string): T | undefined {
  return Array.from(document.querySelectorAll<T>(selector)).find(
    (candidate) => !candidate.closest('[inert]'),
  );
}
function control<T extends HTMLElement>(selector: string): T {
  const element = activeControl<T>(selector);
  check(element, `Missing active control: ${selector}`);
  return element;
}
function click(selector: string): void {
  control<HTMLButtonElement>(selector).click();
}
function input(
  field: HTMLTextAreaElement | HTMLInputElement,
  text: string,
  inputType = 'insertText',
): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, text);
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: text }));
}
function key(field: HTMLElement, keyValue: string, extra: KeyboardEventInit = {}): void {
  field.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: keyValue,
      bubbles: true,
      cancelable: true,
      ...extra,
    }),
  );
}
async function configureSearch(keyword: string, replacement: string): Promise<HTMLInputElement> {
  if (!Array.from(document.querySelectorAll('.searchbar')).some((bar) => !bar.closest('[inert]'))) {
    click('button[aria-label="搜索当前文档"]');
  }
  await until(() => activeControl('.searchbar .search-input'));
  input(control<HTMLInputElement>('.search-input'), keyword);
  await frame();
  if (
    !Array.from(document.querySelectorAll('.search-replace-input')).some(
      (field) => !field.closest('[inert]'),
    )
  ) {
    click('button[aria-label="显示替换"]');
  }
  await until(() => activeControl('.search-replace-input'));
  const field = control<HTMLInputElement>('.search-replace-input');
  input(field, replacement);
  await frame();
  return field;
}
function feedback(): string {
  return activeControl('.search-replace-result')?.textContent ?? '';
}
function hiddenNodes(doc: PMNode): PMNode[] {
  const nodes: PMNode[] = [];
  doc.descendants((node) => {
    if (
      node.type.name === 'math_inline' ||
      node.type.name === 'math_block' ||
      (node.type.name === 'code_block' && String(node.attrs.language).toLowerCase() === 'mermaid')
    ) {
      nodes.push(node);
      return false;
    }
    return true;
  });
  return nodes;
}

async function runRich(testCase: ReplaceCase): Promise<string> {
  const host = document.createElement('div');
  host.className = 'milkdown-container';
  host.style.height = '500px';
  const searchHost = document.createElement('div');
  document.body.append(host, searchHost);
  const formatSource = [
    '### **hello world**',
    '- `hello world`',
    '[hello world](https://example.com/hello-world "original title")',
    'hello **world**',
    'hello world',
    '```js\nhello world\n```',
    '```mermaid\ngraph TD\nA["hello world"]-->B\n```',
    'Inline $\\text{hello world}$ formula.',
    '$$\n\\text{hello world}\n$$',
  ].join('\n\n');
  const original =
    testCase === 'replace-rich-format'
      ? formatSource
      : testCase === 'replace-rich-delete'
        ? '## needle\n\nneedle\n\n```js\nneedle\n```'
        : 'needle needle';
  const editor = createEditor(host, original, { onUpdate: () => {} });
  const searchRoot = createRoot(searchHost);
  try {
    await editor.create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    view.focus();
    searchRoot.render(createElement(SearchBar, { editor, onClose: () => searchRoot.render(null) }));
    await until(() => document.querySelector('.search-input'));

    if (testCase === 'replace-rich-format') {
      const before = view.state.doc;
      const hidden = hiddenNodes(before);
      const field = await configureSearch('hello world', '替换文字');
      check(
        control<HTMLElement>('.search-count').textContent === '6 处',
        'Rich search counted hidden diagram/formula source',
      );
      key(field, 'Enter', { ctrlKey: true });
      await until(() => document.querySelector('.search-replace-result'));
      check(
        feedback() === '已替换 5 处，跳过 1 处（格式不一致）',
        'Mixed-format replacements reported incorrect counts',
      );
      const doc = view.state.doc;
      check(doc.childCount === before.childCount, 'Replacement changed the block structure');
      check(
        doc.firstChild!.type.name === 'heading' && doc.firstChild!.attrs.level === 3,
        'Replacement lost the heading',
      );
      check(
        doc.firstChild!.firstChild!.marks.some((mark) => mark.type.name === 'strong'),
        'Replacement lost bold',
      );
      let link = false;
      let code = false;
      doc.descendants((node) => {
        if (!node.isText || node.text !== '替换文字') return;
        if (node.marks.some((mark) => mark.type.name === 'inlineCode')) code = true;
        if (
          node.marks.some(
            (mark) =>
              mark.type.name === 'link' &&
              mark.attrs.href === 'https://example.com/hello-world' &&
              mark.attrs.title === 'original title',
          )
        )
          link = true;
      });
      check(code, 'Replacement lost inline code marks');
      check(link, 'Replacement changed the link target/title');
      check(doc.child(3).eq(before.child(3)), 'Cross-format phrase was altered instead of skipped');
      const afterHidden = hiddenNodes(doc);
      check(
        afterHidden.length === hidden.length &&
          afterHidden.every((node, at) => node.eq(hidden[at])),
        'Hidden formula or Mermaid source changed',
      );
      check(
        searchPluginKey.getState(view.state)!.count === 1,
        'Remaining skipped match was not searchable',
      );
      check(undoDepth(view.state) === 1, 'Five replacements did not share one history event');
      pmUndo(view.state, view.dispatch);
      check(view.state.doc.eq(before), 'One undo did not restore text, marks and links');
      return `${testCase}: six visible hits; five replacements, one format skip; real Milkdown marks/blocks/links/hidden source and one-step undo passed`;
    }

    if (testCase === 'replace-rich-single') {
      const field = await configureSearch('needle', 'needle needle');
      key(field, 'Enter');
      await until(() => feedback() === '已替换 1 处，跳过 0 处');
      check(
        view.state.doc.textContent === 'needle needle needle',
        'Single replacement rescanned introduced text',
      );
      check(
        view.state.selection.from === 15 && view.state.selection.to === 21,
        'Single replacement did not advance to the original next match',
      );
      check(
        searchPluginKey.getState(view.state)!.current === 2,
        'Rich current highlight did not follow selection',
      );
      key(field, 'Escape');
      await until(() => !document.querySelector('.searchbar'));
      check(
        document.activeElement === view.dom,
        'Closing replace did not restore rendered-editor focus',
      );
      check(
        window.getSelection()?.toString() === 'needle',
        'Closing replace lost the selected occurrence',
      );
      return `${testCase}: Enter replaced one original hit, selected the next, and Esc restored real editable selection/focus`;
    }

    if (testCase === 'replace-rich-delete') {
      const before = view.state.doc;
      const field = await configureSearch('needle', '');
      key(field, 'Enter', { ctrlKey: true });
      await until(() => document.querySelector('.search-replace-result'));
      check(
        feedback() === '已替换 3 处，跳过 0 处',
        'Empty replacement did not delete all three hits',
      );
      check(view.state.doc.childCount === 3, 'Empty replacement removed blocks');
      check(
        view.state.doc.firstChild!.type.name === 'heading',
        'Deleting heading text removed the heading',
      );
      check(
        view.state.doc.lastChild!.type.name === 'code_block' &&
          view.state.doc.lastChild!.attrs.language === 'js',
        'Deleting code text removed its fence/language',
      );
      check(view.state.doc.textContent === '', 'Empty replacement left matched text');
      pmUndo(view.state, view.dispatch);
      check(view.state.doc.eq(before), 'Deleting all text did not undo atomically');
      return `${testCase}: empty replacement retained empty heading/paragraph/code blocks and undo restored them`;
    }

    view.dispatch(view.state.tr.insertText(' before', view.state.doc.content.size - 1));
    const beforeReplacement = view.state.doc;
    const field = await configureSearch('needle', 'updated');
    key(field, 'Enter', { ctrlKey: true });
    await until(() => view.state.doc.textContent === 'updated updated before');
    const afterReplacement = view.state.doc;
    view.dispatch(view.state.tr.insertText(' after', view.state.doc.content.size - 1));
    check(undoDepth(view.state) === 3, 'Replacement joined adjacent rich typing history');
    pmUndo(view.state, view.dispatch);
    check(
      view.state.doc.eq(afterReplacement),
      'First undo consumed replacement and following input together',
    );
    pmUndo(view.state, view.dispatch);
    check(view.state.doc.eq(beforeReplacement), 'Replacement was not one isolated undo');
    pmUndo(view.state, view.dispatch);
    check(
      view.state.doc.textContent === 'needle needle',
      'Pre-replacement typing history was lost',
    );
    pmRedo(view.state, view.dispatch);
    pmRedo(view.state, view.dispatch);
    check(view.state.doc.eq(afterReplacement), 'Rich redo did not restore the replacement event');
    check(
      getCurrentState(editor).markdown.includes('updated updated before'),
      'Serialized Markdown disagrees with replacement',
    );
    return `${testCase}: real Milkdown typing/replacement/typing formed three isolated undo events with redo and serialization intact`;
  } finally {
    searchRoot.unmount();
    await editor.destroy();
    host.remove();
    searchHost.remove();
  }
}

async function newSourceDocument(): Promise<HTMLTextAreaElement> {
  const count = document.querySelectorAll('[role="tab"]').length;
  const previous = document.querySelector('.source-editor:not([hidden]) textarea');
  click('button[title="新建文档 (Ctrl+N)"]');
  await until(() => document.querySelector('.newfile-card'));
  click('.newfile-card');
  await until(() => document.querySelectorAll('[role="tab"]').length === count + 1);
  await until(() => document.querySelector('.editor-tab.active .ProseMirror'));
  if (!document.querySelector('.source-editor:not([hidden])'))
    click('button[aria-label="切换源码模式"]');
  await until(() => {
    const field = document.querySelector('.source-editor:not([hidden]) textarea');
    return field && field !== previous;
  });
  const field = control<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea');
  check(getSourceEditorApi(field), 'App did not register the source history API');
  return field;
}

async function runSource(testCase: ReplaceCase): Promise<string> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(App));
  try {
    await until(() => document.querySelector('button[title="新建文档 (Ctrl+N)"]'));
    let field = await newSourceDocument();
    if (testCase === 'replace-current-document') {
      input(field, 'needle first', 'insertFromPaste');
      await frame();
      const first = field;
      const tabsBefore = document.querySelectorAll('[role="tab"]').length;
      field = await newSourceDocument();
      await until(() => document.querySelectorAll('[role="tab"]').length === tabsBefore + 1);
      input(field, 'needle second', 'insertFromPaste');
      await frame();
      await configureSearch('needle', 'updated');
      click('.search-replace-row button:last-child');
      await until(() => field.value === 'updated second');
      check(first.value === 'needle first', 'Source replace modified a background document');
      const second = field;
      click('[role="tab"]');
      await until(() => document.querySelector('.source-editor:not([hidden]) textarea') === first);
      check(
        !Array.from(document.querySelectorAll('.search-replace-result')).some(
          (node) => !node.closest('[inert]'),
        ),
        'Replacement result leaked to another tab',
      );
      click('button[aria-label="切换源码模式"]');
      await until(() => !document.querySelector('.source-editor:not([hidden])'));
      await configureSearch('needle', 'rendered');
      click('.search-replace-row button:last-child');
      await until(
        () =>
          document.querySelector('.editor-tab.active .ProseMirror')?.textContent ===
          'rendered first',
      );
      check(second.value === 'updated second', 'Rich replace modified another source document');
      click('button[aria-label="切换源码模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden]) textarea') === first);
      check(
        first.value.includes('rendered first'),
        'Rendered replacement was not reflected in the current Markdown source',
      );
      check(second.value === 'updated second', 'Switching views changed the background document');
      return `${testCase}: actual App source and rendered replacements changed only their current tab; feedback and drafts stayed isolated`;
    }

    if (testCase === 'replace-source-literal') {
      const markdown = 'A+B a+b\n\n```mermaid\ngraph TD\nA["a+b"]-->B\n```\n\n$a+b$';
      input(field, markdown, 'insertFromPaste');
      await frame();
      await configureSearch('a+b', 'a+b a+b');
      click('input[aria-label="区分大小写"]');
      await frame();
      check(
        control<HTMLElement>('.search-count').textContent === '3 处',
        'Source case-sensitive count did not use raw Markdown',
      );
      click('.search-replace-row button:last-child');
      await until(() => document.querySelector('.search-replace-result'));
      check(
        feedback() === '已替换 3 处，跳过 0 处',
        'Source replacement count included introduced matches',
      );
      check(
        field.value === 'A+B a+b a+b\n\n```mermaid\ngraph TD\nA["a+b a+b"]-->B\n```\n\n$a+b a+b$',
        'Source did not replace exact Markdown including hidden formula/diagram code',
      );
      field.focus();
      key(field, 'z', { ctrlKey: true });
      await until(() => field.value === markdown);
      return `${testCase}: literal punctuation, shared case switch, frozen matches and raw Mermaid/math source replacement passed`;
    }

    if (testCase === 'replace-source-ime') {
      input(field, 'needle', 'insertFromPaste');
      await frame();
      field.setSelectionRange(6, 6);
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input(field, 'needle ni', 'insertCompositionText');
      await frame();
      const currentText = () => field.value;
      const replacement = await configureSearch('needle', 'updated');
      key(replacement, 'Enter', { ctrlKey: true });
      await until(() => document.querySelector('.search-replace-result'));
      check(currentText() === 'needle ni', 'Replacement changed an active source composition');
      check(
        feedback().includes('当前无法替换'),
        'Active source composition had no actionable feedback',
      );
      input(field, 'needle 你', 'insertCompositionText');
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
      await frame();
      replacement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      key(replacement, 'Enter', { ctrlKey: true, isComposing: true });
      key(replacement, 'Escape', { isComposing: true });
      click('.search-replace-row button:last-child');
      await frame();
      check(
        currentText() === 'needle 你' && document.querySelector('.searchbar'),
        'Replace-input IME shortcut changed or closed the document',
      );
      replacement.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '' }),
      );
      key(replacement, 'Enter', { ctrlKey: true });
      await until(() => field.value === 'updated 你');
      field.focus();
      key(field, 'z', { ctrlKey: true });
      await until(() => field.value === 'needle 你');
      key(field, 'z', { ctrlKey: true });
      await until(() => field.value === 'needle');
      return `${testCase}: real SourceEditor/SearchBar composition events protected Chinese input and kept composition/replacement undo separate`;
    }

    input(field, 'needle needle', 'insertFromPaste');
    await frame();
    input(field, 'needle needle before', 'insertText');
    await frame();
    const replacement = await configureSearch('needle', 'updated');
    key(replacement, 'Enter', { ctrlKey: true });
    await until(() => field.value === 'updated updated before');
    input(field, 'updated updated before after', 'insertText');
    await frame();
    field.focus();
    key(field, 'z', { ctrlKey: true });
    await until(() => field.value === 'updated updated before');
    key(field, 'z', { ctrlKey: true });
    await until(() => field.value === 'needle needle before');
    key(field, 'z', { ctrlKey: true });
    await until(() => field.value === 'needle needle');
    key(field, 'y', { ctrlKey: true });
    await until(() => field.value === 'needle needle before');
    key(field, 'y', { ctrlKey: true });
    await until(() => field.value === 'updated updated before');
    check(
      getSourceEditorApi(field)!.read().text === field.value,
      'Source registry API used stale parent props after undo/redo',
    );
    return `${testCase}: actual App source input/replacement/input stayed in isolated history events; Ctrl+Z/Y and live draft API passed`;
  } finally {
    root.unmount();
    host.remove();
  }
}

/** Real React, App and Milkdown; native IPC is the only simulated boundary. */
export async function runReplaceRegression(testCase: ReplaceCase): Promise<string> {
  createNativeMocks().install();
  await until(() => document.readyState === 'complete');
  await frame();
  return testCase.startsWith('replace-rich-') ? runRich(testCase) : runSource(testCase);
}
