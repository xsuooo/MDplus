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
      expect(html).toContain(`aria-label="添加「${definition.label}」快捷键"`);
      expect(html).toContain(`aria-label="清除「${definition.label}」快捷键"`);
    }
    expect(html.split('class="shortcut-row"').length - 1).toBe(SHORTCUT_DEFINITIONS.length);
  });

  it('显示当前绑定,未绑定的动作显示「未绑定」', () => {
    const html = render();
    for (const definition of SHORTCUT_DEFINITIONS) {
      for (const accelerator of DEFAULT_SHORTCUTS[definition.id]) {
        expect(html).toContain(formatShortcut(accelerator));
      }
    }

    const withUnbound = render({ ...DEFAULT_SHORTCUTS, save: [] });
    expect(withUnbound).toContain('未绑定');
    expect(withUnbound).toContain('class="shortcut-kbd shortcut-kbd-unbound"');
  });

  it('为每个键位提供独立的修改和移除按钮', () => {
    const html = render();

    // toggleOutline 默认是 ctrl+shift+e + f11
    expect(html).toContain('class="shortcut-kbd-list"');
    expect(html).toContain('Ctrl+Shift+E');
    expect(html).toContain('F11');
    expect(html).toContain('aria-label="移除「切换大纲」的 F11"');
    expect(html).toContain('aria-label="移除「切换大纲」的 Ctrl+Shift+E"');
    expect(html).toContain('aria-label="移除「切换源码模式」的 F2"');
    expect(html).toContain('aria-label="修改「切换大纲」的 F11"');
    expect(html).toContain('aria-label="修改「切换大纲」的 Ctrl+Shift+E"');
    expect(html).toContain('title="点击修改"');

    const chips = html.split('class="shortcut-kbd-chip"').length - 1;
    const total = Object.values(DEFAULT_SHORTCUTS).reduce((sum, list) => sum + list.length, 0);
    expect(chips).toBe(total);
  });

  it('省去顶部说明,未绑定行也使用添加按钮', () => {
    const html = render();
    expect(html).not.toContain('shortcuts-description');
    expect(html).not.toContain('Fn 本身通常不产生按键事件');
    expect(html).not.toContain('modal-description');
    expect(render({ ...DEFAULT_SHORTCUTS, save: [] })).toContain('aria-label="添加「保存」快捷键"');
  });

  it('渲染列头、底部操作与捕获态占位之外的静态内容', () => {
    const html = render();
    expect(html).toContain('aria-label="操作项"');
    expect(html).toContain('aria-label="当前快捷键"');
    expect(html).toContain('aria-label="快捷键操作"');
    expect(html).toContain('恢复默认值');
    expect(html).toContain('关闭');
    expect(html).not.toContain('按下快捷键…');
    expect(html).not.toContain('shortcut-conflict');
    expect(html).not.toContain('shortcut-hint');
    expect(html).toContain('role="dialog"');
  });
});

describe('ShortcutModal duplicate bindings', () => {
  it('warns about a persisted duplicate and names the effective and ignored action', () => {
    const html = render({ ...DEFAULT_SHORTCUTS, open: ['ctrl+n'] });

    expect(html).toContain('shortcut-duplicate-warning');
    expect(html).toContain('存在重复绑定');
    expect(html).toContain('已由「新建」使用');
    expect(html).toContain('「打开」不会由此键位触发');
    expect(html).toContain('shortcut-ignored');
  });

  it('shows no warning and no "不生效" marker for a clean configuration', () => {
    const html = render();

    expect(html).not.toContain('shortcut-duplicate-warning');
    expect(html).not.toContain('shortcut-ignored');
  });

  it('keeps both rows listed so the user can clear either one', () => {
    const html = render({ ...DEFAULT_SHORTCUTS, open: ['ctrl+n'] });

    expect(html).toContain('aria-label="修改「新建」的 Ctrl+N"');
    expect(html).toContain('aria-label="修改「打开」的 Ctrl+N"');
    expect(html).toContain('aria-label="清除「打开」快捷键"');
  });
});
