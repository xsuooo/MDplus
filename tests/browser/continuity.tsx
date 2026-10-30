import { createRoot } from 'react-dom/client';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection, NodeSelection } from '@milkdown/prose/state';
import { undoDepth } from '@milkdown/prose/history';
import { createEditor, getCurrentState, setMarkdown } from '../../src/lib/editor';
import App from '../../src/App';
import '../../src/styles/global.css';

export const continuityCases = [
  'sync-identical', 'sync-image-attributes', 'sync-local-edit',
  'source-tab-history', 'mode-reading-anchor', 'mode-selection-roundtrip',
  'font-source-position', 'rendered-tab-position',
  'mode-formatted-blocks',
] as const;
export type ContinuityCase = typeof continuityCases[number];
export const longDocument = Array.from({ length: 35 }, (_, i) =>
  `## Section ${i}\n\n段落 ${i} 中文 Mixed English **bold** and \`code\`. ${'Long paragraph content. '.repeat(8)}\n`).join('\n');

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(condition: () => unknown) {
  const deadline = performance.now() + 10000;
  while (!condition()) {
    check(performance.now() < deadline, 'Continuity regression timed out');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  check(button, `Missing ${selector}`); button.click();
}
function input(field: HTMLTextAreaElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function runContinuityRegression(testCase: ContinuityCase): Promise<string> {
  if (testCase.startsWith('sync-')) {
    const host = document.createElement('div');
    host.className = 'milkdown-container'; host.style.height = '420px';
    const search = document.createElement('input');
    document.body.append(host, search);
    const updates: string[] = [];
    const original = `![first](mdplus-image:one)\n\n${longDocument}\n\n![last](mdplus-image:two)`;
    const editor = createEditor(host, original, { onUpdate: (u) => updates.push(u.markdown) });
    await editor.create();
    try {
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      let pos = 0;
      view.state.doc.descendants((node, at) => {
        if (node.isText && node.text?.includes('段落 17')) pos = at + 5;
      });
      if (testCase === 'sync-image-attributes') {
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
      } else view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos, pos + 8)));
      const selection = view.state.selection.toJSON();
      const beforeDoc = view.state.doc;
      const beforeNode = host.querySelector('h2:nth-of-type(18)');
      const depth = undoDepth(view.state);
      host.scrollTop = 1600;
      const top = host.scrollTop;
      search.focus();
      const markdown = testCase === 'sync-image-attributes'
        ? original.replace('mdplus-image:one', './assets/first.png').replace('mdplus-image:two', './assets/last.png')
        : testCase === 'sync-local-edit' ? original.replace('Section 0', 'Section Zero') : getCurrentState(editor).markdown;
      setMarkdown(editor, markdown);
      check(document.activeElement === search, 'Background sync stole focus');
      check(host.scrollTop === top, 'Background sync changed scroll position');
      check(host.querySelector('h2:nth-of-type(18)') === beforeNode, 'Unchanged blocks were rebuilt');
      if (testCase === 'sync-identical') {
        check(view.state.doc === beforeDoc && undoDepth(view.state) === depth, 'Identical sync changed document/history');
      } else if (testCase === 'sync-image-attributes') {
        check(JSON.stringify(view.state.selection.toJSON()) === JSON.stringify(selection), 'Image migration changed node selection');
      } else {
        check(view.state.selection.from === pos + 3 && view.state.selection.to === pos + 11, 'Selection did not map across a preceding edit');
      }
      return `${testCase}: focus, selection, scroll, unchanged nodes and no-op history passed`;
    } finally { await editor.destroy(); host.remove(); search.remove(); }
  }

  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); root.render(<App />);
  try {
    await until(() => document.querySelector('button[title="新建文档 (Ctrl+N)"]'));
    click('button[title="新建文档 (Ctrl+N)"]'); await until(() => document.querySelector('.newfile-card'));
    click('.newfile-card'); await until(() => document.querySelector('.ProseMirror'));
    click('button[aria-label="切换源码模式"]'); await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'));
    let field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')!;
    if (testCase === 'mode-formatted-blocks') {
      const fixtures = [
        ['## Same heading\n\nFirst paragraph\n\n## Same heading\n\nSecond **目标文字** with 中文🙂.', '目标文字'],
        ['- outer\n  - nested **列表文本**\n  - other', '列表文本'],
        ['> 引用 **中间内容** 后文', '中间内容'],
        ['| A | B |\n|---|---|\n| 1 | 表格文本 |', '表格文本'],
        ['```ts\nconst greeting = "代码文本";\n```', '代码文本'],
        ['正文 $x^2$ 后面的中文🙂文本', '中文🙂'],
      ];
      for (const [markdown, selected] of fixtures) {
        input(field, markdown);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const at = markdown.indexOf(selected);
        field.setSelectionRange(at, at + selected.length);
        click('button[aria-label="切换源码模式"]');
        await until(() => !document.querySelector('.source-editor:not([hidden])'));
        check(window.getSelection()?.toString() === selected, `Lost selected text in structured block: ${selected} => ${window.getSelection()?.toString()}`);
        click('button[aria-label="切换源码模式"]');
        await until(() => document.querySelector('.source-editor:not([hidden])'));
        field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
        check(field.value.slice(field.selectionStart, field.selectionEnd) === selected, 'Structured selection did not return to source');
      }
      return `${testCase}: duplicate headings, lists, quote, table, code and inline-math text selections passed`;
    }
    input(field, longDocument);
    await until(() => field.value === longDocument);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const selection = longDocument.indexOf('段落 17') + 5;
    field.setSelectionRange(selection, selection + 8, 'backward');
    field.dispatchEvent(new Event('select', { bubbles: true }));
    field.scrollTop = 1400;
    const sourceTop = field.scrollTop;
    if (testCase === 'font-source-position') {
      click('button[aria-label="排版设置"]');
      await until(() => document.querySelector('.typography-panel'));
      for (const font of ['fira-wenkai', 'cascadia-misans', 'jetbrains-sarasa']) {
        const select = document.querySelector<HTMLSelectElement>('select[aria-label="源码与代码字体"]')!;
        select.value = font; select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await document.fonts.ready;
        check(field.selectionStart === selection && field.selectionEnd === selection + 8, 'Font change lost source selection');
        check(field.scrollTop === sourceTop, 'Font change moved source scroll position');
        check(field.value === longDocument, 'Font change edited Markdown');
      }
    } else if (testCase === 'rendered-tab-position') {
      click('button[aria-label="切换源码模式"]');
      await until(() => !document.querySelector('.source-editor:not([hidden])'));
      const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
      const scroller = document.querySelector<HTMLElement>('.editor-tab.active .milkdown-container')!;
      scroller.scrollTop = 1500;
      click('button[title="新建文档 (Ctrl+N)"]'); await until(() => document.querySelector('.newfile-card'));
      click('.newfile-card'); await until(() => document.querySelectorAll('[role="tab"]').length === 2);
      click('[role="tab"]'); await until(() => document.querySelector('.editor-tab.active .ProseMirror') === editor);
      check(scroller.scrollTop === 1500, 'Switching rendered tabs lost viewport');
      check(editor.querySelectorAll('h2').length === 35, 'Source edits in a background tab were not synchronized');
    } else if (testCase === 'source-tab-history') {
      click('button[title="新建文档 (Ctrl+N)"]'); await until(() => document.querySelector('.newfile-card'));
      click('.newfile-card'); await until(() => document.querySelectorAll('[role="tab"]').length === 2);
      click('[role="tab"]');
      await until(() => document.querySelector('[role="tab"]')?.classList.contains('active'));
      if (!document.querySelector('.source-editor:not([hidden])')) click('button[aria-label="切换源码模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden])'));
      field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
      check(field.value === longDocument, 'Tab switch changed the source draft');
      check(field.selectionStart === selection && field.selectionEnd === selection + 8, `Tab switch lost source selection: ${field.selectionStart},${field.selectionEnd} expected ${selection}`);
      check(field.scrollTop === sourceTop, 'Tab switch lost source scroll');
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
      await until(() => field.value === '');
    } else {
      click('button[aria-label="切换源码模式"]');
      await until(() => !document.querySelector('.source-editor:not([hidden])'));
      const scroller = document.querySelector<HTMLElement>('.editor-tab.active .milkdown-container')!;
      if (testCase === 'mode-reading-anchor') {
        check(scroller.scrollTop > 500, 'Mode switch returned to document top instead of the reading paragraph');
      }
      click('button[aria-label="切换源码模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden])'));
      field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
      check(field.selectionStart === selection && field.selectionEnd === selection + 8, `Mode round trip lost source selection: ${field.selectionStart},${field.selectionEnd} expected ${selection}`);
      check(field.selectionDirection === 'backward', 'Mode round trip lost selection direction');
      check(Math.abs(field.scrollTop - sourceTop) < 2, 'Mode round trip moved reading position');
    }
    return `${testCase}: real source editor state survives view changes`;
  } finally { root.unmount(); host.remove(); }
}
