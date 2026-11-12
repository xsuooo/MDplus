import { editorViewCtx } from '@milkdown/kit/core';
import { createNativeMocks } from './nativeMocks';
import { undoDepth, redoDepth } from '@milkdown/prose/history';
import { TextSelection } from '@milkdown/prose/state';
import { createEditor, getCurrentState, setMarkdown, undo } from '../../src/lib/editor';
import { captureExport } from '../../src/lib/export';
import '../../src/styles/global.css';

export const codeBlockCases = [
  'code-block-copy',
  'code-block-copy-updated',
  'code-block-copy-failure',
  'code-block-copy-pending',
  'code-block-copy-destroy',
  'code-block-export',
  'code-block-language',
  'code-block-copy-keyboard',
  'code-block-copy-keyboard-failure',
  'code-block-copy-keyboard-move',
  'code-block-layout-1280-800',
  'code-block-layout-800-600',
  'code-block-layout-390-844',
] as const;
export type CodeBlockCase = (typeof codeBlockCases)[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function until(condition: () => unknown): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    check(performance.now() < deadline, 'Code-block interaction timed out');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

/** Real Milkdown view/model/DOM; only the OS clipboard transport is stubbed. */
export async function runCodeBlockRegression(testCase: CodeBlockCase): Promise<string> {
  createNativeMocks().install();
  // Navigation can focus the initial editor; selection checks start after page loading.
  await until(() => document.readyState === 'complete');
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  document.documentElement.dataset.theme = 'light';
  const root = document.createElement('div');
  root.className = 'milkdown-container';
  root.style.height = '540px';
  document.body.append(root);
  const source =
    'const answer = "中文 <tag> & value";\n\t// 保留制表符、空行和长行\n\n' +
    '超长题目内容 '.repeat(50);
  const markdown = '```typescript\n' + source + '\n```\n\n```\n\n```';
  const editor = createEditor(root, markdown, { onUpdate: () => {} });
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const copied: string[] = [];
  // Read the mutable count again after asynchronous clipboard completion.
  const copyCount = (): number => copied.length;
  let fail =
    testCase === 'code-block-copy-failure' || testCase === 'code-block-copy-keyboard-failure';
  let release: (() => void) | undefined;
  let destroyed = false;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
        if (fail) throw new DOMException('Permission denied', 'NotAllowedError');
        if (
          testCase === 'code-block-copy-pending' ||
          testCase === 'code-block-copy-destroy' ||
          testCase === 'code-block-copy-keyboard-move'
        ) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
    },
  });
  try {
    await editor.create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    const block = root.querySelector<HTMLElement>('.md-code-block');
    const button = block?.querySelector<HTMLButtonElement>('button[aria-label="复制代码块内容"]');
    check(block && button, 'Fenced code block is missing its accessible copy button');
    const pre = block.querySelector('pre')!;
    const code = pre.querySelector('code')!;
    const controls = button.parentElement!;
    check(
      controls.contentEditable === 'false' && !code.contains(button),
      'Copy controls are editable document content',
    );

    if (testCase.startsWith('code-block-layout-')) {
      for (const theme of ['light', 'dark']) {
        document.documentElement.dataset.theme = theme;
        const frame = block.getBoundingClientRect();
        const controlBox = button.getBoundingClientRect();
        check(controlBox.width >= 24 && controlBox.height >= 24, 'Copy target is too small');
        check(
          controlBox.right <= frame.right && controlBox.left >= frame.left,
          'Copy button overflows the block',
        );
        check(
          controls.getBoundingClientRect().bottom <= pre.getBoundingClientRect().top + 1,
          'Copy controls cover the first content line',
        );
        check(pre.scrollWidth > pre.clientWidth, 'Fixture did not create horizontal overflow');
        check(
          getComputedStyle(pre).cursor === 'default',
          'Scrollbar host still inherits a text cursor',
        );
        check(getComputedStyle(code).cursor === 'text', 'Editable code lost its text cursor');
        check(
          getComputedStyle(pre, '::-webkit-scrollbar-thumb').cursor === 'default',
          'Custom scrollbar cursor was not reset',
        );
        pre.scrollLeft = pre.scrollWidth;
        check(pre.scrollLeft > 0, 'Long code cannot scroll horizontally');
        check(
          Math.abs(button.getBoundingClientRect().right - controlBox.right) <= 1,
          'Copy button scrolls out of view with the code',
        );
        button.focus({ preventScroll: true });
        check(document.activeElement === button, 'Copy button is not keyboard focusable');
        check(getComputedStyle(button).outlineStyle !== 'none', 'Keyboard focus is invisible');
        check(
          document.documentElement.scrollWidth <= innerWidth,
          'Code block forces page-wide horizontal scrolling',
        );
      }
      return `${testCase}: light/dark layout, focus, cursor and horizontal scrolling passed`;
    }

    if (testCase === 'code-block-language') {
      view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { language: 'javascript' }));
      check(
        code.className === 'language-javascript' && controls.textContent?.includes('javascript'),
        'Language change left stale code chrome',
      );
      setMarkdown(editor, '```mermaid\ngraph TD\nA-->B\n```');
      check(
        root.querySelector('.md-mermaid-node') && !root.querySelector('.md-code-copy'),
        'Ordinary code view replaced the Mermaid renderer',
      );
      setMarkdown(editor, '```text\nback to ordinary code\n```');
      const nextButton = root.querySelector<HTMLButtonElement>('.md-code-copy');
      check(nextButton, 'Mermaid-to-code conversion lost the copy button');
      nextButton.click();
      await until(() => nextButton.getAttribute('aria-busy') !== 'true');
      check(copied[0] === 'back to ordinary code', 'Rebuilt code view copied stale Mermaid text');
      return `${testCase}: ordinary language updates and Mermaid view switching passed`;
    }

    if (testCase.startsWith('code-block-copy-keyboard')) {
      const next = document.createElement('button');
      next.textContent = 'Next control';
      root.append(next);
      button.focus({ preventScroll: true });
      button.click();
      check(document.activeElement === button, 'Copying disables or blurs the focused button');
      if (testCase === 'code-block-copy-keyboard-move') {
        next.focus();
        release!();
      }
      await until(() => button.getAttribute('aria-busy') !== 'true');
      if (fail) {
        check(
          button.textContent === '复制失败' && document.activeElement === button,
          'Copy failure lost keyboard focus',
        );
        fail = false;
        button.click();
        await until(() => button.getAttribute('aria-busy') !== 'true');
      }
      check(
        document.activeElement === (testCase === 'code-block-copy-keyboard-move' ? next : button),
        'Async copy stole or lost keyboard focus',
      );
      check(
        button.textContent === '已复制' && !button.hasAttribute('aria-disabled'),
        'Keyboard copy left a disabled or failed state',
      );
      next.remove();
      return `${testCase}: focused-button activation, retry and asynchronous focus ownership passed`;
    }
    if (testCase === 'code-block-copy-updated') {
      view.dispatch(view.state.tr.insertText('LATEST ', 1));
    }
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 7)));
    view.focus();
    pre.scrollLeft = 150;
    const before = {
      doc: view.state.doc,
      selection: view.state.selection,
      markdown: getCurrentState(editor).markdown,
      undo: undoDepth(view.state),
      redo: redoDepth(view.state),
      left: pre.scrollLeft,
      top: root.scrollTop,
    };
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button.click();
    check(
      copied.length === 1 && copied[0] === before.doc.firstChild!.textContent,
      'Copy did not use the exact current block text',
    );
    check(!copied[0].includes('复制代码块内容'), 'Copied text includes UI chrome');

    if (testCase === 'code-block-copy-destroy') {
      await editor.destroy();
      destroyed = true;
      release!();
      await Promise.resolve();
      await Promise.resolve();
      return `${testCase}: pending copy safely settled after view destruction`;
    }
    if (testCase === 'code-block-copy-pending') {
      button.click();
      check(
        button.getAttribute('aria-disabled') === 'true' && copied.length === 1,
        'Pending copy allowed duplicate requests',
      );
      release!();
    }
    await until(() => button.getAttribute('aria-busy') !== 'true');
    check(
      button.isConnected && root.querySelector('.md-code-copy') === button,
      'Copy feedback rebuilt its code-block node view',
    );
    if (testCase === 'code-block-copy-failure') {
      check(
        button.textContent === '复制失败' &&
          controls.querySelector('[role="status"]')?.textContent?.includes('失败'),
        'Clipboard denial falsely reports success or has no error feedback',
      );
      fail = false;
      button.click();
      await until(
        () => button.getAttribute('aria-busy') !== 'true' && button.textContent === '已复制',
      );
      check(copyCount() === 2, 'Clipboard failure cannot be retried');
    } else {
      check(button.textContent === '已复制', 'Successful copy has no feedback');
      check(
        controls.querySelector('[role="status"]')?.textContent?.includes('已复制'),
        'Copy feedback is not announced',
      );
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    check(
      view.state.doc.eq(before.doc) && getCurrentState(editor).markdown === before.markdown,
      'Copy feedback polluted Markdown',
    );
    check(
      view.state.selection.eq(before.selection) && document.activeElement === view.dom,
      `Pointer copy changed focus/selection: ${JSON.stringify({ before: before.selection.toJSON(), after: view.state.selection.toJSON(), active: document.activeElement?.className, expected: view.dom.className })}`,
    );
    check(
      undoDepth(view.state) === before.undo && redoDepth(view.state) === before.redo,
      'Copy created an undo transaction',
    );
    check(
      pre.scrollLeft === before.left && root.scrollTop === before.top,
      'Copy reset document or code scrolling',
    );

    if (testCase === 'code-block-export') {
      const snapshot = captureExport(
        editor,
        before.markdown,
        'Code fixture',
        'misans',
        'jetbrains-sarasa',
        (src) => src,
      );
      check(
        !snapshot.content.querySelector(
          'button, .md-code-block, .md-code-controls, [role="status"]',
        ),
        'Portable export contains copy controls',
      );
      check(
        snapshot.content.querySelector('pre code')?.textContent === source,
        'Export changed the code text',
      );
    }
    if (testCase === 'code-block-copy-updated') {
      undo(editor);
      check(
        view.state.doc.firstChild!.textContent === source,
        'Copy interfered with undo of the preceding edit',
      );
    }
    if (testCase === 'code-block-copy') {
      const emptyButton = root.querySelectorAll<HTMLButtonElement>('.md-code-copy')[1];
      check(emptyButton, 'Empty code block has no copy action');
      emptyButton.click();
      await until(() => emptyButton.getAttribute('aria-busy') !== 'true');
      check(copied[1] === '', 'Empty code block copied chrome instead of empty text');
    }
    return `${testCase}: passed (exact clipboard payload, live model, clean Markdown/history/selection/scroll)`;
  } finally {
    release?.();
    if (!destroyed) await editor.destroy();
    root.remove();
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
}
