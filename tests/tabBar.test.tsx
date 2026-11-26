// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabBar } from '../src/components/TabBar';
import type { Tab } from '../src/lib/types';
import { DEFAULT_SHORTCUTS } from '../src/lib/shortcuts';

afterEach(cleanup);

const tab: Tab = {
  id: 'document',
  title: 'note.md',
  path: null,
  isNew: true,
  dirty: false,
  diskMtime: 0,
  diskRevision: null,
  externalChanged: false,
  initialContent: '',
  savedContent: '',
  markdown: '',
  stats: { chars: 0, words: 0, lines: 1 },
};

describe('tab keyboard interaction', () => {
  it('does not show an empty tab strip before a document is opened', () => {
    render(
      <TabBar
        bindings={DEFAULT_SHORTCUTS}
        tabs={[]}
        activeId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('uses a readable full path in the tooltip and accessible tab name', () => {
    render(
      <TabBar
        bindings={DEFAULT_SHORTCUTS}
        tabs={[{ ...tab, path: '\\\\?\\E:\\桌面\\note.md', isNew: false }]}
        activeId={tab.id}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    const element = screen.getByRole('tab', { name: 'note.md,E:\\桌面\\note.md' });
    expect(element.getAttribute('title')).toBe('E:\\桌面\\note.md');
  });

  it('keeps the decorative state slot separate from the accessible file name', () => {
    render(
      <TabBar
        bindings={DEFAULT_SHORTCUTS}
        tabs={[
          { ...tab, id: 'saved', title: 'saved.md', path: 'C:/notes/saved.md', isNew: false },
          { ...tab, id: 'edited', title: 'edited.md', isNew: false, dirty: true },
          { ...tab, id: 'changed', title: 'changed.md', isNew: false, externalChanged: true },
        ]}
        activeId="saved"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    const slots = screen.getAllByRole('tab').map((element) => element.querySelector('.tab-dot')!);
    expect(slots.map((slot) => slot.getAttribute('aria-hidden'))).toEqual(['true', 'true', 'true']);
    expect(
      slots.map((slot) => [slot.getAttribute('data-dirty'), slot.getAttribute('data-external')]),
    ).toEqual([
      ['0', '0'],
      ['1', '0'],
      ['0', '1'],
    ]);
    expect(slots[2].getAttribute('title')).toBe('文件已在外部修改');
    expect(screen.getByRole('tab', { name: 'edited.md,未保存' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'changed.md,文件已在其他应用中修改' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((element) => element.textContent)).toEqual([
      'saved.md',
      'edited.md',
      'changed.md',
    ]);
  });

  it.each<[string, string | undefined]>([
    ['想法.第二稿.MD', '.MD'],
    ['notes.markdown', '.markdown'],
    ['未命名 1', undefined],
    ['notes.md.txt', undefined],
  ])('preserves %s while styling only its Markdown extension', (title, extension) => {
    render(
      <TabBar
        bindings={DEFAULT_SHORTCUTS}
        tabs={[{ ...tab, title, isNew: false }]}
        activeId={tab.id}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    const element = screen.getByRole('tab', { name: title });
    expect(element.textContent).toBe(title);
    expect(element.querySelector('.tab-extension')?.textContent).toBe(extension);
  });

  it.each(['Enter', ' '])('preserves %j activation on the nested close button', (key) => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TabBar
        bindings={DEFAULT_SHORTCUTS}
        tabs={[tab]}
        activeId={tab.id}
        onSelect={onSelect}
        onClose={onClose}
        onNew={vi.fn()}
      />,
    );
    const close = screen.getByRole('button', { name: '关闭 note.md' });

    expect(fireEvent.keyDown(close, { key })).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledWith(tab.id);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('still selects the tab itself with %j', (key) => {
    const onSelect = vi.fn();
    render(
      <TabBar
        bindings={DEFAULT_SHORTCUTS}
        tabs={[tab]}
        activeId={tab.id}
        onSelect={onSelect}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );

    expect(fireEvent.keyDown(screen.getByRole('tab'), { key })).toBe(false);
    expect(onSelect).toHaveBeenCalledWith(tab.id);
  });
});
