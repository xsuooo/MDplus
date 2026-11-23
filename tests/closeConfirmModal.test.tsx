// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloseConfirmModal } from '../src/components/CloseConfirmModal';

afterEach(cleanup);

describe('close confirmation feedback', () => {
  it('names the destructive close consequence and preserves each callback action without extra confirmation', () => {
    const onConfirm = vi.fn();
    render(<CloseConfirmModal title="项目笔记.md" busy={false} onConfirm={onConfirm} />);
    expect(screen.getByRole('dialog', { name: '关闭「项目笔记.md」' })).toBeTruthy();
    const description = document.getElementById('close-document-description');
    expect(description?.textContent).toContain('丢弃');
    fireEvent.click(screen.getByRole('button', { name: '丢弃更改并关闭' }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith('discard');
    fireEvent.click(screen.getByRole('button', { name: '保存并关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(onConfirm.mock.calls).toEqual([['discard'], ['save'], ['cancel']]);
  });

  it('shows pending close feedback but leaves continue-editing and Escape cancellation available while busy', () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <CloseConfirmModal title="项目笔记.md" busy={true} onConfirm={onConfirm} />,
    );
    expect(screen.getByRole('status').textContent).toContain('正在处理关闭');
    expect(screen.getByRole('status').textContent).toContain('继续编辑');
    expect(screen.getByRole('status').textContent).not.toContain('已保存');
    expect(screen.getByRole('status').textContent).not.toContain('已关闭');
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    expect(buttons.slice(0, 2).every((button) => button.disabled)).toBe(true);
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: '继续编辑' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onConfirm.mock.calls).toEqual([['cancel'], ['cancel']]);
    rerender(<CloseConfirmModal title="项目笔记.md" busy={false} onConfirm={onConfirm} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('false');
    expect((screen.getByRole('button', { name: '保存并关闭' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('preserves focus trapping and the labelled description', () => {
    render(<CloseConfirmModal title="项目笔记.md" busy={false} onConfirm={() => {}} />);
    const first = screen.getByRole('button', { name: '保存并关闭' });
    const last = screen.getByRole('button', { name: '继续编辑' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    expect(screen.getByRole('dialog').getAttribute('aria-describedby')).toBe(
      'close-document-description',
    );
  });
});
