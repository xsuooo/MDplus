import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OutlinePanel } from '../src/components/OutlinePanel';
import { OUTLINE_WIDTH_MAX, OUTLINE_WIDTH_MIN } from '../src/lib/outlineWidth';

function render(width: number, open = true): string {
  return renderToStaticMarkup(
    <OutlinePanel open={open} onToggle={() => {}} items={[]} onJump={() => {}} width={width} onWidthChange={() => {}} />,
  );
}

describe('OutlinePanel resizing affordance', () => {
  it('exposes a vertical separator carrying the current width', () => {
    const html = render(300);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-label="调整目录宽度"');
    expect(html).toContain('aria-valuemin="' + OUTLINE_WIDTH_MIN + '"');
    expect(html).toContain('aria-valuemax="' + OUTLINE_WIDTH_MAX + '"');
    expect(html).toContain('aria-valuenow="300"');
    expect(html).toContain('tabindex="0"');
  });

  it('drives the panel width through the CSS variable', () => {
    expect(render(275)).toContain('--outline-width:275px');
  });

  it('hides the separator while the panel is collapsed', () => {
    expect(render(300, false)).not.toContain('role="separator"');
  });
});
