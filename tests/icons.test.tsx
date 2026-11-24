import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconPage } from '../src/components/icons';

describe('tab page mark', () => {
  it('is a decorative stroke icon that inherits the tab color', () => {
    const markup = renderToStaticMarkup(<IconPage size={14} aria-hidden="true" />);
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('width="14"');
    expect(markup).toContain('aria-hidden="true"');
  });
});
