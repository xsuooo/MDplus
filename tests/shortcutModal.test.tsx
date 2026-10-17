import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  formatShortcut,
  type ShortcutBindings,
} from '../src/lib/shortcuts';
import { ShortcutModal } from '../src/components/ShortcutModal';

function render(bindings: ShortcutBindings = DEFAULT_SHORTCUTS): string {
  return renderToStaticMarkup(
    <ShortcutModal bindings={bindings} onChange={() => {}} onClose={() => {}} />,
  );
}

describe('ShortcutModal', () => {
  it('按分组列出全部动作,并为行内按钮提供可访问名称', () => {
    const html = render();

    const groups = ['文件', '视图', '标签'];
    let lastIndex = -1;
    for (const group of groups) {
      const index = html.indexOf(`>${group}</th>`);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }

    for (const definition of SHORTCUT_DEFINITIONS) {
      expect(html).toContain(`>${definition.label}</th>`);
      expect(html).toContain(`aria-label="修改「${definition.label}」快捷键"`);
      expect(html).toContain(`aria-label="清除「${definition.label}」快捷键"`);
    }
    expect(html.split('class="shortcut-row"').length - 1).toBe(SHORTCUT_DEFINITIONS.length);
  });

  it('显示当前绑定,未绑定的动作显示「未绑定」', () => {
    const html = render();
    for (const definition of SHORTCUT_DEFINITIONS) {
      expect(html).toContain(formatShortcut(DEFAULT_SHORTCUTS[definition.id]));
    }

    const withUnbound = render({ ...DEFAULT_SHORTCUTS, save: null });
    expect(withUnbound).toContain('未绑定');
    expect(withUnbound).toContain('class="shortcut-kbd shortcut-kbd-unbound"');
  });

  it('渲染列头、底部操作与捕获态占位之外的静态内容', () => {
    const html = render();
    expect(html).toContain('aria-label="操作项"');
    expect(html).toContain('aria-label="当前快捷键"');
    expect(html).toContain('aria-label="快捷键操作"');
    expect(html).toContain('恢复默认值');
    expect(html).toContain('关闭');
    expect(html).not.toContain('按下新组合键…');
    expect(html).not.toContain('shortcut-conflict');
    expect(html).toContain('role="dialog"');
  });
});

describe('ShortcutModal duplicate bindings', () => {
  it('warns about a persisted duplicate and names the effective and ignored action', () => {
    const html = render({ ...DEFAULT_SHORTCUTS, open: 'ctrl+n' });

    expect(html).toContain('shortcut-duplicate-warning');
    expect(html).toContain('存在重复绑定');
    expect(html).toContain('已由「新建」使用');
    expect(html).toContain('「打开」不会触发');
    expect(html).toContain('shortcut-ignored');
  });

  it('shows no warning and no "不生效" marker for a clean configuration', () => {
    const html = render();

    expect(html).not.toContain('shortcut-duplicate-warning');
    expect(html).not.toContain('shortcut-ignored');
  });

  it('keeps both rows listed so the user can clear either one', () => {
    const html = render({ ...DEFAULT_SHORTCUTS, open: 'ctrl+n' });

    expect(html).toContain('aria-label="修改「新建」快捷键"');
    expect(html).toContain('aria-label="修改「打开」快捷键"');
    expect(html).toContain('aria-label="清除「打开」快捷键"');
  });
});
