// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import katex, { type KatexOptions } from 'katex';
import { DOMParser } from '@milkdown/kit/prose/model';
import { editorViewCtx, type Editor } from '@milkdown/kit/core';
import { createEditor, getCurrentState, setMarkdown } from '../src/lib/editor';

const editors: { editor: Editor; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const { editor, host } of editors.splice(0)) {
    await editor.destroy();
    host.remove();
  }
});

async function open(markdown: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createEditor(host, markdown, { onUpdate: () => {} });
  editors.push({ editor, host });
  await editor.create();
  return { editor, host, view: editor.action((ctx) => ctx.get(editorViewCtx)) };
}

describe('KaTeX security and rendering compatibility', () => {
  it('does not inherit trusted rendering from the options prototype', () => {
    const options: KatexOptions = Object.create({ trust: true });
    const html = katex.renderToString(String.raw`\href{javascript:alert(1)}{unsafe}`, options);
    expect(html).not.toContain('href="javascript:');
  });

  it('keeps explicit untrusted rendering enforced', () => {
    const html = katex.renderToString(String.raw`\href{javascript:alert(1)}{unsafe}`, {
      trust: false,
    });
    expect(html).not.toContain('href="javascript:');
  });

  it.each([
    String.raw`x^2 + y^2 = z^2`,
    String.raw`\frac{1}{2} + \sqrt{x}`,
    String.raw`\sum_{n=1}^{\infty} \frac{1}{n^2}`,
    String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`,
    String.raw`\begin{aligned} a &= b+c \\ d &= e+f \end{aligned}`,
  ])('renders supported math without relaxing trust: %s', (formula) => {
    for (const displayMode of [false, true]) {
      const html = katex.renderToString(formula, { displayMode, trust: false, throwOnError: true });
      expect(html).toContain('class="katex');
      expect(html).not.toContain('katex-error');
    }
  });
});

describe('real editor math security and fallback', () => {
  it.each(['inline', 'block'])(
    'renders invalid %s LaTeX as a safe alert while retaining its source',
    async (kind) => {
      const formula = String.raw`\unknown{<img src=x onerror=alert(1)>}`;
      const markdown = kind === 'inline' ? '$' + formula + '$' : '$$\n' + formula + '\n$$';
      const { editor, host, view } = await open(markdown);
      const dom = host.querySelector<HTMLElement>('[data-type="math_' + kind + '"]')!;
      expect(dom.dataset.value).toBe(formula);
      const alert = dom.querySelector<HTMLElement>('.katex-error[role="alert"]')!;
      expect(alert.textContent).toBe('公式有误：' + formula);
      expect(alert.title).toContain('Undefined control sequence');
      expect(alert.style.color).toBe('var(--danger)');
      expect(dom.querySelector('img')).toBeNull();
      const parsed = DOMParser.fromSchema(view.state.schema).parse(
        host.querySelector('.ProseMirror')!,
      );
      const mathNode = kind === 'inline' ? parsed.firstChild!.firstChild! : parsed.firstChild!;
      expect(kind === 'inline' ? mathNode.textContent : mathNode.attrs.value).toBe(formula);
      const saved = getCurrentState(editor).markdown;
      setMarkdown(editor, saved, false);
      expect(getCurrentState(editor).markdown).toBe(saved);
      expect(host.querySelector('.katex-error[role="alert"]')?.textContent).toBe(
        '公式有误：' + formula,
      );
    },
  );

  it.each(['inline', 'block'])('enforces trust:false in actual %s math DOM', async (kind) => {
    const formula = String.raw`\href{javascript:alert(1)}{unsafe}`;
    const { host } = await open(
      kind === 'inline' ? '$' + formula + '$' : '$$\n' + formula + '\n$$',
    );
    const dom = host.querySelector<HTMLElement>('[data-type="math_' + kind + '"]')!;
    expect(dom.querySelector('.katex')).not.toBeNull();
    expect(dom.querySelector('[href]')).toBeNull();
    expect(dom.dataset.value).toBe(formula);
  });
});
