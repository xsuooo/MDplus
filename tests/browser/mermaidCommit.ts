import { editorViewCtx } from '@milkdown/kit/core';
import { createEditor, undo } from '../../src/lib/editor';
import { refreshMermaidTheme } from '../../src/lib/mermaid';
import '../../src/styles/global.css';

export const mermaidCases = [
  'mermaid-clear-preview', 'mermaid-clear-blur', 'mermaid-clear-escape', 'mermaid-edit-preview',
  'mermaid-theme-stable', 'mermaid-theme-editing',
] as const;
export type MermaidCase = typeof mermaidCases[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function until(condition: () => unknown) {
  const deadline = performance.now() + 15000;
  while (!condition()) {
    check(performance.now() < deadline, 'Timed out waiting for the Mermaid source editor');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

/** Real Milkdown NodeView events and document history; no mocked commit algorithm. */
export async function runMermaidCommitRegression(testCase: MermaidCase): Promise<string> {
  document.documentElement.dataset.theme = 'light';
  const original = 'graph TD\nA-->B';
  const root = document.createElement('div');
  document.body.append(root);
  const editor = createEditor(root, `\`\`\`mermaid\n${original}\n\`\`\``, { onUpdate: () => {} });
  const errors: string[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.message);
  await editor.create();
  try {
    await until(() => root.querySelector<HTMLElement>('.md-mermaid-holder')?.onclick);
    if (testCase === 'mermaid-theme-stable') {
      const holder = root.querySelector<HTMLElement>('.md-mermaid-holder')!;
      const originalFrame = holder.querySelector('iframe');
      check(originalFrame, 'Sandbox frame is missing');
      const height = holder.getBoundingClientRect().height;
      const heights: number[] = [];
      const observer = new ResizeObserver(() => heights.push(holder.getBoundingClientRect().height));
      observer.observe(holder);
      try {
        for (const theme of ['dark', 'light', 'dark', 'light']) {
          const previousFrame = holder.querySelector('iframe');
          document.documentElement.dataset.theme = theme;
          refreshMermaidTheme();
          check(previousFrame?.isConnected, 'Theme refresh removed the visible diagram before its replacement was ready');
          await until(() => !holder.parentElement!.classList.contains('loading'));
          const frame = holder.querySelector('iframe');
          check(frame && frame !== previousFrame, 'Theme refresh did not replace the diagram');
          check(frame.hasAttribute('sandbox') && !frame.sandbox.contains('allow-scripts')
            && !frame.sandbox.contains('allow-same-origin'), 'Diagram sandbox was weakened');
        }
        check(heights.every((value) => Math.abs(value - height) <= 1), `Diagram height jumped: ${height} => ${heights}`);
        return `${testCase}: stable sandbox frame height through four theme changes`;
      } finally {
        observer.disconnect();
      }
    }
    root.querySelector<HTMLElement>('.md-mermaid-holder')!.click();
    const textarea = root.querySelector<HTMLTextAreaElement>('.md-mermaid-textarea');
    check(textarea, 'Mermaid source editor did not open');
    check(textarea.value === original, 'Fixture did not start with a nonempty diagram');
    if (testCase === 'mermaid-theme-editing') {
      textarea.value = 'graph TD\nA-->Draft';
      document.documentElement.dataset.theme = 'dark';
      refreshMermaidTheme();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      check(textarea.isConnected && textarea.value.includes('Draft'), 'Theme refresh discarded an uncommitted diagram draft');
      return `${testCase}: uncommitted source and focus retained`;
    }
    const expected = testCase === 'mermaid-edit-preview' ? 'graph TD\nA-->C' : '';
    textarea.value = expected;
    window.addEventListener('error', onError);
    if (testCase === 'mermaid-clear-blur') {
      textarea.blur();
    } else if (testCase === 'mermaid-clear-escape') {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else {
      root.querySelector<HTMLButtonElement>('.md-mermaid-commit')!.click();
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    check(errors.length === 0, `Mermaid commit threw: ${errors.join('; ')}`);
    const code = () => editor.action((ctx) => {
      const node = ctx.get(editorViewCtx).state.doc.firstChild;
      check(node?.type.name === 'code_block' && node.attrs.language === 'mermaid', 'Diagram block was removed');
      return node.textContent;
    });
    check(code() === expected, 'Mermaid commit retained the old diagram content');
    undo(editor);
    check(code() === original, 'Undo did not restore the diagram content');
    return `${testCase}: passed (real Milkdown NodeView and undo)`;
  } finally {
    window.removeEventListener('error', onError);
    await editor.destroy();
    root.remove();
  }
}
