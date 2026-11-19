// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Toolbar } from '../src/components/Toolbar';
import { DEFAULT_SHORTCUTS } from '../src/lib/shortcuts';

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true })));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'keeps secondary actions accessible with an active document: %s',
  (active) => {
    const props: ComponentProps<typeof Toolbar> = {
      bindings: DEFAULT_SHORTCUTS,
      onOpen: vi.fn(),
      onNew: vi.fn(),
      onNewExample: vi.fn(),
      onSave: vi.fn(),
      onSaveAs: vi.fn(),
      onInsertImage: vi.fn(),
      pickingImage: false,
      onExportHTML: vi.fn(),
      onExportPDF: vi.fn(),
      hasActiveTab: active,
      activeIsNew: false,
      saving: false,
      exporting: active,
      onSearch: vi.fn(),
      searchOpen: false,
      onToggleOutline: vi.fn(),
      outlineOpen: false,
      sourceMode: false,
      onToggleSource: vi.fn(),
      onRecent: vi.fn(),
      recentOpen: false,
      onOpenShortcuts: vi.fn(),
      onWindowClose: vi.fn(),
    };
    render(<Toolbar {...props} />);
    const more = screen.getByRole('button', { name: '更多文件操作' });
    fireEvent.click(more);
    const sample = screen.getByRole('menuitem', { name: '打开示例文档' });
    const saveAs = screen.getByRole('menuitem', { name: '另存为' });
    expect(document.activeElement).toBe(active ? saveAs : sample);
    expect((saveAs as HTMLButtonElement).disabled).toBe(!active);
    expect(
      (screen.getByRole('menuitem', { name: '导出为 HTML' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(sample);
    fireEvent.keyDown(sample, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: '打开示例文档' }));
    expect(props.onNewExample).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新建', exact: true }));
    expect(props.onNew).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  },
);
