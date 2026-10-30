import { describe, expect, it } from 'vitest';
import katex, { type KatexOptions } from 'katex';

describe('KaTeX security and rendering compatibility', () => {
  it('does not inherit trusted rendering from the options prototype', () => {
    const options: KatexOptions = Object.create({ trust: true });
    const html = katex.renderToString(String.raw`\href{javascript:alert(1)}{unsafe}`, options);
    expect(html).not.toContain('href="javascript:');
  });

  it('keeps explicit untrusted rendering enforced', () => {
    const html = katex.renderToString(String.raw`\href{javascript:alert(1)}{unsafe}`, { trust: false });
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
