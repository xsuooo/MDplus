import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconBrand, IconPage } from '../src/components/icons';

const attributes = (markup: string, name: string) =>
  [...markup.matchAll(new RegExp(' ' + name + '="([^"]*)"', 'g'))].map((match) => match[1]);

describe('brand mark', () => {
  const asset = readFileSync(new URL('../src/assets/app-icon.svg', import.meta.url), 'utf8');
  const inline = renderToStaticMarkup(<IconBrand size={18} />);

  it('draws the same geometry as the desktop icon and favicon artwork', () => {
    expect(attributes(asset, 'd')).toHaveLength(2);
    expect(attributes(inline, 'd')).toEqual(attributes(asset, 'd'));
    expect(attributes(inline, 'viewBox')).toEqual(attributes(asset, 'viewBox'));
    expect(attributes(inline, 'transform')).toEqual(attributes(asset, 'transform'));
    expect(attributes(inline, 'rx')).toEqual(attributes(asset, 'rx'));
    // The letter is a stroked path; its stroke geometry is part of the artwork.
    for (const stroke of [
      'stroke-width="52"',
      'stroke-linejoin="miter"',
      'stroke-linecap="butt"',
    ]) {
      expect(asset).toContain(stroke);
      expect(inline).toContain(stroke);
    }
  });

  it('takes its colors from the stylesheet instead of an image or a filter', () => {
    expect(inline).not.toContain('<image');
    expect(attributes(inline, 'class')).toEqual(['brand-tile', 'brand-ink-stroke', 'brand-ink']);
    // Hard-coded paint here would win over the theme tokens.
    expect(inline).not.toMatch(/#[0-9a-f]{3,8}/i);
    const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
    for (const theme of ['light', 'dark']) {
      const block = new RegExp("html\\[data-theme='" + theme + "'\\] \\{[^}]*\\}").exec(css);
      expect(block?.[0]).toMatch(/--brand-tile: #[0-9a-f]{6};/);
      expect(block?.[0]).toMatch(/--brand-ink: #[0-9a-f]{6};/);
    }
    for (const sheet of ['global.css', 'studio.css', 'welcome.css']) {
      const text = readFileSync(new URL('../src/styles/' + sheet, import.meta.url), 'utf8');
      expect(text).not.toMatch(/(toolbar-brand-logo|welcome-logo)[^{}]*\{[^}]*filter:/);
    }
  });
});

describe('tab page mark', () => {
  it('is a decorative stroke icon that inherits the tab color', () => {
    const markup = renderToStaticMarkup(<IconPage size={14} aria-hidden="true" />);
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('width="14"');
    expect(markup).toContain('aria-hidden="true"');
  });
});
