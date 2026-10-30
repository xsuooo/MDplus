import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import '../../src/styles/global.css';

export const typographyCases = [
  'typography-defaults', 'typography-independent-fonts', 'typography-layout',
  'typography-panel-keyboard', 'typography-persistence', 'typography-long-document',
  'typography-global-ui', 'typography-shortcut-fonts', 'typography-error-font',
] as const;
export type TypographyCase = typeof typographyCases[number];

export const typographyDocument = `# MDPlus 排版校准：把注意力留给内容

这是一份中文技术文档。正文需要清晰的层级和适中的密度，而不是把每个句子都排成代码。English paragraphs should read naturally alongside 中文、数字 0123456789 与标点。**重点文字保持清晰，不靠模拟加粗。**

## 阅读与编辑，各有分工

正文使用比例字体，\`inline code\` 使用等宽字体。切换正文样式，不应改变代码的对齐。The quick brown fox jumps over the lazy dog; narrow letters like iii and wide letters like WWW must retain proportional spacing.

### 一段实际代码

\`\`\`typescript
function formatTitle(title: string): string {
  const prefix = "中文标题";
  return \`\${prefix}: \${title}\`;
}
const longLine = "${'0123456789'.repeat(24)}";
\`\`\`

### 列表与引用

- 第一项说明
  - 嵌套内容，保持紧凑但不拥挤。
- 第二项说明
- [x] 已完成的任务
- [ ] 换行任务 ${'这是一段较长的任务描述，用来观察复选框与首行的对齐。'.repeat(3)}

> 引用应与正文保持一致，不突然换回衬线字体。
>
> **重要说明**：\`Ctrl+S\` 保存内容，字体选择不会修改 Markdown。

## 表格、长链接与公式

| 项目 | 说明 | 状态 |
| --- | --- | --- |
| 001 | 中文 English mixed text | 正常 |
| 002 | ${'LONG_IDENTIFIER_'.repeat(20)} | 待检查 |

https://example.com/${'unbroken-segment-'.repeat(30)}

行内公式 $e^{i\\pi}+1=0$ 与正文并排。

$$
\\frac{1}{2}+\\sqrt{x^2+y^2}
$$

#### 四级标题

普通正文。

##### 五级标题

补充说明。

###### 六级标题

最后一段，不增加多余留白。
`;

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function sameFont(selector: string, reference: Element) {
  const nodes = document.querySelectorAll(selector);
  check(nodes.length, `Missing font surface: ${selector}`);
  for (const node of nodes) {
    check(getComputedStyle(node).fontFamily === getComputedStyle(reference).fontFamily,
      `Font does not follow preference: ${selector} (${getComputedStyle(node).fontFamily})`);
  }
}
async function until(condition: () => unknown) {
  const end = performance.now() + 15000;
  while (!condition()) {
    check(performance.now() < end, 'Typography regression timed out');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector);
  check(element, `Missing typography control: ${selector}`); element.click();
}
async function change(label: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  check(select, `Missing ${label}`); select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await document.fonts.ready;
}
async function openDocument(text = typographyDocument) {
  await until(() => document.querySelector('button[title="新建文档 (Ctrl+N)"]'));
  click('button[title="新建文档 (Ctrl+N)"]');
  await until(() => document.querySelector('.newfile-card'));
  click('.newfile-card');
  await until(() => document.querySelector('.editor-tab.active .ProseMirror'));
  click('button[aria-label="切换源码模式"]');
  await until(() => document.querySelector('.source-editor:not([hidden]) textarea'));
  const source = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(source, text);
  source.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  click('button[aria-label="切换源码模式"]');
  await until(() => !document.querySelector('.source-editor:not([hidden])'));
  await document.fonts.ready;
}

export async function runTypographyRegression(testCase: TypographyCase): Promise<string> {
  localStorage.removeItem('mdplus-body-font');
  localStorage.removeItem('mdplus-editor-font');
  if (testCase === 'typography-persistence') localStorage.setItem('mdplus-editor-font', 'fira-wenkai');
  const host = document.createElement('div'); document.body.append(host);
  let root = createRoot(host); root.render(<App />);
  try {
    await openDocument(testCase === 'typography-long-document'
      ? Array.from({ length: 40 }, (_, i) => `## 长文 ${i}\n\n${'中文 English 阅读段落。'.repeat(20)}\n\n\`\`\`js\nconst n = ${i};\n\`\`\`\n`).join('\n')
      : typographyDocument);
    const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
    const code = editor.querySelector<HTMLElement>('pre code')!;
    const source = document.querySelector<HTMLTextAreaElement>('.source-textarea')!;
    if (testCase === 'typography-defaults') {
      check(getComputedStyle(editor).fontFamily.startsWith('"MDPlus MiSans"'), 'Body is not using proportional MiSans');
      check(getComputedStyle(code).fontFamily.startsWith('"MDPlus JetBrains Mono"'), 'Code default is not JetBrains Mono / Sarasa');
      check(getComputedStyle(source).fontFamily === getComputedStyle(code).fontFamily, 'Source and code use different font roles');
      check(getComputedStyle(editor).fontSize === '16px' && getComputedStyle(editor).lineHeight === '28px', 'Body baseline must be 16px / 1.75');
      check(getComputedStyle(source).lineHeight === '25.6px', 'Source line-height must be independent of prose');
      const faces = await document.fonts.load('600 16px "MDPlus MiSans"', '中文 Bold');
      check(faces.some((face) => face.weight === '600' && face.status === 'loaded'), 'MiSans real semibold is not bundled');
    } else if (testCase === 'typography-global-ui') {
      const original = source.value;
      for (const font of ['wenkai', 'sarasa', 'misans']) {
        click('button[aria-label="排版设置"]'); await until(() => document.querySelector('.typography-panel'));
        await change('界面与正文字体', font);
        for (const selector of ['body', '.toolbar button', '.tab-title', '.statusbar', '.typography-panel h3', '.typography-panel select']) {
          sameFont(selector, editor);
        }
        check(getComputedStyle(document.body, '::after').fontFamily === getComputedStyle(editor).fontFamily,
          'Document-level drag overlay does not follow the UI font');
        click('button[aria-label="关闭排版设置"]');
        click('button[aria-label="搜索当前文档"]'); await until(() => document.querySelector('.searchbar'));
        sameFont('.searchbar input', editor); sameFont('.searchbar button', editor);
        click('button[aria-label="关闭搜索"]');
        click('button[aria-label="打开最近文件"]'); await until(() => document.querySelector('.recent-menu'));
        sameFont('.recent-menu-header', editor); click('.menu-mask');
        click('button[title="新建文档 (Ctrl+N)"]'); await until(() => document.querySelector('.newfile-modal'));
        sameFont('.newfile-modal h3', editor); sameFont('.newfile-modal button', editor);
        click('.newfile-modal .modal-actions button');
      }
      check(source.value === original, 'Changing UI fonts modified the document');
    } else if (testCase === 'typography-shortcut-fonts') {
      const original = source.value;
      click('button[aria-label="打开快捷键设置"]'); await until(() => document.querySelector('.shortcut-modal'));
      sameFont('.shortcut-kbd, .shortcut-kbd kbd', code);
      click('button[aria-label="关闭快捷键设置"]');
      for (const [body, codeFont] of [['wenkai', 'fira-wenkai'], ['sarasa', 'cascadia-misans'], ['misans', 'jetbrains-sarasa']]) {
        click('button[aria-label="排版设置"]'); await until(() => document.querySelector('.typography-panel'));
        await change('界面与正文字体', body); await change('源码与代码字体', codeFont);
        click('button[aria-label="关闭排版设置"]');
        click('button[aria-label="打开快捷键设置"]'); await until(() => document.querySelector('.shortcut-modal'));
        sameFont('.shortcut-modal h3', editor); sameFont('.shortcut-table th', editor);
        sameFont('.shortcut-actions button', editor); sameFont('.shortcut-modal .modal-actions button', editor);
        sameFont('.shortcut-kbd, .shortcut-kbd kbd', code);
        click('.shortcut-kbd-edit'); await until(() => document.querySelector('.shortcut-kbd-capturing'));
        sameFont('.shortcut-kbd-capturing, .shortcut-kbd-capturing kbd', editor);
        sameFont('.shortcut-recording-hint', editor);
        document.querySelector('.shortcut-modal')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await until(() => !document.querySelector('.shortcut-kbd-capturing'));
        check(document.querySelector('.shortcut-modal'), 'Canceling recording closed the dialog');
        sameFont('.shortcut-kbd, .shortcut-kbd kbd', code);
        click('button[aria-label="关闭快捷键设置"]');
      }
      check(source.value === original, 'Shortcut font checks modified Markdown');
    } else if (testCase === 'typography-error-font') {
      click('button[aria-label="排版设置"]'); await until(() => document.querySelector('.typography-panel'));
      await change('界面与正文字体', 'wenkai');
      const selected = getComputedStyle(editor).fontFamily;
      function BrokenView(): never { throw new Error('Synthetic typography error boundary regression'); }
      root.render(<ErrorBoundary><BrokenView /></ErrorBoundary>);
      await until(() => host.querySelector('h2')?.textContent === '出了点问题');
      await document.fonts.ready;
      check(getComputedStyle(host.querySelector('h2')!).fontFamily === selected, 'Error fallback ignores the selected UI font');
      sameFont('button', host.querySelector('h2')!);
    } else if (testCase === 'typography-layout') {
      for (const width of [1100, 800]) {
        host.style.width = `${width}px`;
        for (const zoom of [1, 1.2, 2]) {
          document.querySelector<HTMLElement>('.editor-area')!.style.setProperty('--editor-zoom', String(zoom));
          const computed = getComputedStyle(editor);
          check(parseFloat(computed.width) <= 721, 'Reading measure exceeds 720px before zoom');
          const text = editor.querySelector('p')!;
          check(text.getBoundingClientRect().width <= editor.getBoundingClientRect().width + 1, 'Body overflows its reading column');
          check(editor.querySelector('pre')!.scrollWidth > editor.querySelector('pre')!.clientWidth, 'Long code is not horizontally scrollable');
          const table = editor.querySelector('.tableWrapper') ?? editor.querySelector('table')!.parentElement!;
          check(table.getBoundingClientRect().width <= editor.getBoundingClientRect().width + 1, 'Table is clipped outside its scrolling wrapper');
          check(host.scrollWidth <= width + 1, 'Document content forces application overflow');
        }
      }
    } else if (testCase === 'typography-panel-keyboard') {
      click('button[aria-label="排版设置"]');
      await until(() => document.querySelector('.typography-panel'));
      const panel = document.querySelector<HTMLElement>('.typography-panel')!;
      check(panel.querySelectorAll('select').length === 2, 'Panel must expose both font roles');
      check(document.activeElement === panel.querySelector('select'), 'Panel did not focus its first control');
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await until(() => !document.querySelector('.typography-panel'));
      check(document.activeElement?.getAttribute('aria-label') === '排版设置', 'Escape did not restore trigger focus');
      click('button[aria-label="排版设置"]');
      editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await until(() => !document.querySelector('.typography-panel'));
    } else if (testCase === 'typography-independent-fonts') {
      const original = source.value;
      const originalCode = getComputedStyle(code).fontFamily;
      click('button[aria-label="排版设置"]'); await until(() => document.querySelector('.typography-panel'));
      for (const [body, family, weight] of [['sarasa', 'MDPlus Sarasa Gothic SC', '600'], ['wenkai', 'MDPlus LXGW WenKai', '500'], ['misans', 'MDPlus MiSans', '600']]) {
        await change('界面与正文字体', body);
        check(getComputedStyle(editor).fontFamily.startsWith(`"${family}"`), 'Body font did not apply');
        check(getComputedStyle(code).fontFamily === originalCode, 'Body font setting changed code font');
        const faces = await document.fonts.load(`${weight} 16px "${family}"`, '中文 Bold');
        check(faces.some((face) => face.weight === weight && face.status === 'loaded'), `Missing real emphasis weight: ${family}`);
      }
      const body = getComputedStyle(editor).fontFamily;
      for (const preset of ['fira-wenkai', 'cascadia-misans', 'jetbrains-sarasa']) {
        await change('源码与代码字体', preset);
        check(getComputedStyle(editor).fontFamily === body, 'Code choice changed body font');
        check(source.value === original, 'Typography choice modified Markdown');
        check(getComputedStyle(document.querySelector('.typography-preview-code')!).fontFamily === getComputedStyle(code).fontFamily,
          'Code preview does not match document code');
      }
    } else if (testCase === 'typography-persistence') {
      check(getComputedStyle(editor).fontFamily.startsWith('"MDPlus MiSans"'), 'Legacy code setting leaked into body default');
      check(getComputedStyle(code).fontFamily.startsWith('"MDPlus Fira Code"'), 'Existing code preference was lost');
      click('button[aria-label="排版设置"]'); await until(() => document.querySelector('.typography-panel'));
      await change('界面与正文字体', 'wenkai');
      await change('源码与代码字体', 'cascadia-misans');
      root.unmount(); root = createRoot(host); root.render(<App />);
      await openDocument();
      check(getComputedStyle(document.querySelector('.ProseMirror')!).fontFamily.startsWith('"MDPlus LXGW WenKai"'), 'Body preference did not survive remount');
      check(getComputedStyle(document.querySelector('.ProseMirror pre code')!).fontFamily.startsWith('"MDPlus Cascadia Code"'), 'Code preference did not survive remount');
      click('button[aria-label="打开快捷键设置"]'); await until(() => document.querySelector('.shortcut-modal'));
      sameFont('.shortcut-modal h3', document.querySelector('.ProseMirror')!);
      sameFont('.shortcut-kbd, .shortcut-kbd kbd', document.querySelector('.ProseMirror pre code')!);
    } else {
      click('button[aria-label="切换源码模式"]'); await until(() => document.querySelector('.source-editor:not([hidden]) textarea'));
      source.focus(); source.setSelectionRange(500, 530, 'backward'); source.scrollTop = 1300;
      const top = source.scrollTop; const value = source.value;
      click('button[aria-label="排版设置"]'); await until(() => document.querySelector('.typography-panel'));
      await change('界面与正文字体', 'wenkai'); await change('源码与代码字体', 'cascadia-misans');
      check(source.selectionStart === 500 && source.selectionEnd === 530 && source.selectionDirection === 'backward', 'Typography panel lost the source selection');
      check(source.scrollTop === top && source.value === value, `Typography panel moved or edited the long source draft: ${source.scrollTop} vs ${top}`);
    }
    return `${testCase}: passed (real React/Milkdown, local fonts and browser geometry)`;
  } finally { root.unmount(); host.remove(); }
}
