import { editorViewCtx } from '@milkdown/kit/core';
import { createNativeMocks } from './nativeMocks';
import { createEditor, getCurrentState, undo } from '../../src/lib/editor';
import { refreshMermaidTheme } from '../../src/lib/mermaid';
import '../../src/styles/global.css';

export const mermaidCases = [
  'mermaid-clear-preview',
  'mermaid-clear-blur',
  'mermaid-clear-escape',
  'mermaid-edit-preview',
  'mermaid-theme-stable',
  'mermaid-theme-editing',
  'mermaid-live-draft',
  'mermaid-unchanged-blur',
  'mermaid-theme-latest',
  'mermaid-stale-render',
] as const;
export type MermaidCase = (typeof mermaidCases)[number];

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
  createNativeMocks().install();
  document.documentElement.dataset.theme = 'light';
  const original = 'graph TD\nA-->B';
  const root = document.createElement('div');
  document.body.append(root);
  const editor = createEditor(root, `\`\`\`mermaid\n${original}\n\`\`\``, { onUpdate: () => {} });
  const errors: string[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.message);
  await editor.create();
  try {
    await until(
      () =>
        root.querySelector('.md-mermaid-preview img') &&
        !root.querySelector('.md-mermaid-node.loading'),
    );
    if (testCase === 'mermaid-theme-stable') {
      const holder = root.querySelector<HTMLElement>('.md-mermaid-holder')!;
      const originalFrame = holder.querySelector('.md-mermaid-preview img');
      check(originalFrame, 'Sandbox frame is missing');
      const height = holder.getBoundingClientRect().height;
      const heights: number[] = [];
      const observer = new ResizeObserver(() =>
        heights.push(holder.getBoundingClientRect().height),
      );
      observer.observe(holder);
      const { default: mermaid } = await import('mermaid');
      const render = mermaid.render;
      let renderCalls = 0;
      mermaid.render = (...args: Parameters<typeof render>) => {
        renderCalls++;
        return render(...args);
      };
      const frames = new Map<string, Element>([['light', originalFrame]]);
      const elapsed: number[] = [];
      try {
        for (const theme of ['dark', 'light', 'dark', 'light']) {
          const previousFrame = holder.querySelector('.md-mermaid-preview img');
          document.documentElement.dataset.theme = theme;
          const started = performance.now();
          const refreshed = refreshMermaidTheme();
          if (!frames.has(theme))
            check(
              previousFrame?.isConnected,
              'Theme refresh removed the visible diagram before its replacement was ready',
            );
          await refreshed;
          elapsed.push(performance.now() - started);
          const frame = holder.querySelector<HTMLImageElement>('.md-mermaid-preview img');
          check(frame && frame !== previousFrame, 'Theme refresh did not replace the diagram');
          if (frames.has(theme))
            check(frame === frames.get(theme), 'Returning to a rendered theme rebuilt its image');
          else frames.set(theme, frame);
          check(
            frame.src.startsWith('data:image/svg+xml') && frame.naturalWidth > 0,
            'Diagram stopped using decoded inert SVG images',
          );
        }
        check(
          heights.every((value) => Math.abs(value - height) <= 1),
          `Diagram height jumped: ${height} => ${heights}`,
        );
        check(renderCalls === 1, `Four theme changes need one fresh render, got ${renderCalls}`);
        return `${testCase}: stable inert image height; 1 fresh render across four theme changes; refresh ms=${JSON.stringify(elapsed)}`;
      } finally {
        mermaid.render = render;
        observer.disconnect();
      }
    }
    if (testCase === 'mermaid-theme-latest') {
      const holder = root.querySelector<HTMLElement>('.md-mermaid-holder')!;
      const originalFrame = holder.querySelector('.md-mermaid-preview img');
      const { default: mermaid } = await import('mermaid');
      const render = mermaid.render;
      let renderCalls = 0;
      mermaid.render = (...args: Parameters<typeof render>) => {
        renderCalls++;
        return render(...args);
      };
      try {
        const requests: Promise<void>[] = [];
        for (const theme of ['dark', 'light', 'dark', 'light']) {
          document.documentElement.dataset.theme = theme;
          requests.push(refreshMermaidTheme());
        }
        check(
          holder.querySelector('.md-mermaid-preview img') === originalFrame &&
            !root.querySelector('.md-mermaid-node.loading'),
          'Latest cached theme did not restore the decoded preview immediately',
        );
        await Promise.all(requests);
        check(renderCalls === 0, `Obsolete theme requests entered Mermaid ${renderCalls} times`);
        check(
          holder.querySelector('.md-mermaid-preview img') === originalFrame &&
            document.documentElement.dataset.theme === 'light',
          'An obsolete render replaced the latest theme',
        );
        return `${testCase}: four rapid theme requests reused the final image, 0 Mermaid renders`;
      } finally {
        mermaid.render = render;
      }
    }
    if (testCase === 'mermaid-unchanged-blur') {
      const holder = root.querySelector<HTMLElement>('.md-mermaid-holder')!;
      const originalFrame = holder.querySelector<HTMLImageElement>('.md-mermaid-preview img')!;
      const markdown = getCurrentState(editor).markdown;
      const { default: mermaid } = await import('mermaid');
      const render = mermaid.render;
      let renderCalls = 0;
      mermaid.render = (...args: Parameters<typeof render>) => {
        renderCalls++;
        return render(...args);
      };
      const elapsed: number[] = [];
      try {
        for (const action of ['blur', 'preview', 'escape'] as const) {
          root.querySelector<HTMLElement>('.md-mermaid-edit')!.click();
          const textarea = root.querySelector<HTMLTextAreaElement>('.md-mermaid-textarea')!;
          const started = performance.now();
          if (action === 'blur') textarea.blur();
          else if (action === 'preview')
            root.querySelector<HTMLButtonElement>('.md-mermaid-commit')!.click();
          else
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          elapsed.push(performance.now() - started);
          check(
            holder.querySelector('.md-mermaid-preview img') === originalFrame &&
              originalFrame.naturalWidth > 0 &&
              !root.querySelector('.md-mermaid-node.loading') &&
              !textarea.isConnected,
            `Unchanged ${action} did not restore its decoded preview synchronously`,
          );
          check(getCurrentState(editor).markdown === markdown, `Unchanged ${action} edited source`);
          undo(editor);
          check(
            getCurrentState(editor).markdown === markdown,
            `Unchanged ${action} added undo content`,
          );
        }
        check(renderCalls === 0, `Unchanged commits rendered Mermaid ${renderCalls} times`);
        return `${testCase}: blur/preview/Escape restored identical decoded image synchronously, 0 renders; commit ms=${JSON.stringify(elapsed)}`;
      } finally {
        mermaid.render = render;
      }
    }
    if (testCase === 'mermaid-stale-render') {
      const holder = root.querySelector<HTMLElement>('.md-mermaid-holder')!;
      const originalFrame = holder.querySelector('.md-mermaid-preview img');
      const { default: mermaid } = await import('mermaid');
      const render = mermaid.render;
      let release!: () => void;
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      let intermediateReady = false;
      const rendered: string[] = [];
      mermaid.render = async (...args: Parameters<typeof render>) => {
        const result = await render(...args);
        rendered.push(args[1]);
        // Hold a completed real render across the next edit to exercise the
        // same race as a complex diagram finishing after its source changes.
        if (args[1].includes('Intermediate')) {
          intermediateReady = true;
          await delayed;
        }
        return result;
      };
      try {
        const commit = (code: string) => {
          root.querySelector<HTMLElement>('.md-mermaid-edit')!.click();
          const textarea = root.querySelector<HTMLTextAreaElement>('.md-mermaid-textarea')!;
          textarea.value = code;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.blur();
        };
        commit('graph TD\nA-->Intermediate');
        await until(() => intermediateReady);
        check(
          holder.querySelector('.md-mermaid-preview img') === originalFrame,
          'Editing a new graph discarded the old decoded preview while loading',
        );
        commit('graph TD\nA-->Latest');
        const started = performance.now();
        release();
        await until(() => !root.querySelector('.md-mermaid-node.loading'));
        const image = holder.querySelector<HTMLImageElement>('.md-mermaid-preview img');
        check(
          image && image !== originalFrame && image.naturalWidth > 0,
          'Latest graph did not decode',
        );
        const decoded = atob(image.src.split(',')[1]);
        check(
          decoded.includes('Latest') && !decoded.includes('Intermediate'),
          'An obsolete render replaced the latest graph preview',
        );
        check(
          editor.action((ctx) => ctx.get(editorViewCtx).state.doc.firstChild!.textContent) ===
            'graph TD\nA-->Latest',
          'Completing an obsolete render modified the source document',
        );
        check(rendered.length === 2, 'The held render or latest graph did not exercise Mermaid');
        return `${testCase}: completed obsolete render discarded; source and latest decoded image retained; latest ms=${performance.now() - started}`;
      } finally {
        release();
        mermaid.render = render;
      }
    }
    const originalFrame = root.querySelector<HTMLImageElement>('.md-mermaid-preview img');
    root.querySelector<HTMLElement>('.md-mermaid-edit')!.click();
    const textarea = root.querySelector<HTMLTextAreaElement>('.md-mermaid-textarea');
    check(textarea, 'Mermaid source editor did not open');
    check(textarea.value === original, 'Fixture did not start with a nonempty diagram');
    if (testCase === 'mermaid-live-draft') {
      textarea.value = 'graph TD\nA-->UnsavedDraft';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      check(
        editor.action((ctx) => ctx.get(editorViewCtx).state.doc.firstChild!.textContent) ===
          textarea.value,
        'Save/recovery would read old Mermaid source before blur',
      );
      await refreshMermaidTheme();
      check(
        textarea.isConnected && document.activeElement === textarea,
        'Live draft update replaced the focused editor',
      );
      return `${testCase}: save and recovery see live source without leaving edit mode`;
    }
    if (testCase === 'mermaid-theme-editing') {
      textarea.value = 'graph TD\nA-->Draft';
      document.documentElement.dataset.theme = 'dark';
      await refreshMermaidTheme();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      check(
        textarea.isConnected &&
          textarea.value.includes('Draft') &&
          document.activeElement === textarea,
        'Theme refresh discarded an uncommitted diagram draft or its focus',
      );
      const lightFrame = originalFrame;
      check(lightFrame, 'The original decoded theme image is missing');
      const markdown = getCurrentState(editor).markdown;
      // The source was left unchanged, but its effective theme changed while editing.
      textarea.value = original;
      textarea.blur();
      await until(
        () =>
          root.querySelector<HTMLImageElement>('.md-mermaid-preview img')?.naturalWidth &&
          !root.querySelector('.md-mermaid-node.loading'),
      );
      const frame = root.querySelector<HTMLImageElement>('.md-mermaid-preview img')!;
      check(
        frame !== lightFrame &&
          frame.src !== lightFrame.src &&
          frame.src.startsWith('data:image/svg+xml'),
        'An unchanged commit reused the old theme image after an edit-time theme change',
      );
      check(
        getCurrentState(editor).markdown === markdown,
        'Refreshing the edit-time theme changed the Markdown source',
      );
      return `${testCase}: uncommitted source and focus retained; unchanged blur used the latest theme`;
    }
    const expected = testCase === 'mermaid-edit-preview' ? 'graph TD\nA-->C' : '';
    textarea.value = expected;
    window.addEventListener('error', onError);
    const started = performance.now();
    if (testCase === 'mermaid-clear-blur') {
      textarea.blur();
    } else if (testCase === 'mermaid-clear-escape') {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else {
      root.querySelector<HTMLButtonElement>('.md-mermaid-commit')!.click();
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    check(errors.length === 0, `Mermaid commit threw: ${errors.join('; ')}`);
    const code = () =>
      editor.action((ctx) => {
        const node = ctx.get(editorViewCtx).state.doc.firstChild;
        check(
          node?.type.name === 'code_block' && node.attrs.language === 'mermaid',
          'Diagram block was removed',
        );
        return node.textContent;
      });
    check(code() === expected, 'Mermaid commit retained the old diagram content');
    let elapsed: number | undefined;
    if (testCase === 'mermaid-edit-preview') {
      await until(() => !root.querySelector('.md-mermaid-node.loading'));
      const image = root.querySelector<HTMLImageElement>('.md-mermaid-preview img');
      check(
        image && image !== originalFrame && image.naturalWidth > 0,
        'Changed Mermaid source retained the old preview or failed to decode',
      );
      const svg = new DOMParser()
        .parseFromString(atob(image.src.split(',')[1]), 'text/html')
        .querySelector('svg');
      check(svg?.textContent?.includes('C'), 'Changed Mermaid preview lost its new node label');
      elapsed = performance.now() - started;
    }
    undo(editor);
    check(code() === original, 'Undo did not restore the diagram content');
    return `${testCase}: passed (real Milkdown NodeView and undo)${elapsed === undefined ? '' : `; changed preview ms=${elapsed}`}`;
  } finally {
    window.removeEventListener('error', onError);
    await editor.destroy();
    root.remove();
  }
}
