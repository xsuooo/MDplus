// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryModal } from '../src/components/RecoveryModal';
import { deleteSnapshot, type RecoveryEntry } from '../src/lib/recovery';
import { confirmDialog, showMessage } from '../src/lib/dialog';

vi.mock('../src/lib/recovery', () => ({ deleteSnapshot: vi.fn() }));
vi.mock('../src/lib/dialog', () => ({ confirmDialog: vi.fn(), showMessage: vi.fn() }));

const entries: RecoveryEntry[] = [
  { id: 'a', title: '项目笔记.md', originalPath: 'C:/notes/a.md', updatedAt: 1000, damaged: false },
  { id: 'b', title: '会议记录.md', originalPath: null, updatedAt: 2000, damaged: false },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(current = entries) {
  const onRestore = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
  const onRemove = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <RecoveryModal entries={current} onRestore={onRestore} onRemove={onRemove} onClose={onClose} />,
  );
  const rows = () => Array.from(view.container.querySelectorAll<HTMLElement>('.recovery-entry'));
  return { ...view, rows, onRestore, onRemove, onClose };
}

beforeEach(() => {
  vi.mocked(confirmDialog).mockResolvedValue(true);
  vi.mocked(deleteSnapshot).mockResolvedValue(undefined);
  vi.mocked(showMessage).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('recovery operation feedback', () => {
  it('locks repeated restore actions synchronously before the busy render', async () => {
    const pending = deferred<void>();
    const { rows, onRestore, onClose } = setup();
    onRestore.mockReturnValue(pending.promise);
    const restore = within(rows()[0]).getByRole('button', { name: '恢复副本' });
    act(() => {
      restore.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      restore.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRestore).toHaveBeenCalledExactlyOnceWith('a');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => pending.resolve(undefined));
  });

  it('identifies a delayed restore and blocks repeated actions until it settles', async () => {
    const pending = deferred<void>();
    const { rows, onRestore, onRemove, onClose } = setup();
    onRestore.mockReturnValue(pending.promise);
    fireEvent.click(within(rows()[0]).getByRole('button', { name: '恢复副本' }));

    expect(screen.getByRole('status').textContent).toContain('正在恢复「项目笔记.md」');
    expect(screen.getByRole('status').textContent).not.toContain('会议记录');
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
    for (const row of rows())
      for (const button of within(row).getAllByRole('button'))
        expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '稍后处理' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(within(rows()[1]).getByRole('button', { name: '恢复副本' }));
    expect(onRestore).toHaveBeenCalledExactlyOnceWith('a');
    expect(onRemove).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => pending.resolve(undefined));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('false');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['keyboard', 'mouse'] as const)(
    'allows %s dismissal of a pending restore without cancelling its operation',
    async (mode) => {
      const pending = deferred<void>();
      const { rows, onRestore, onRemove, onClose } = setup();
      onRestore.mockReturnValue(pending.promise);
      fireEvent.click(within(rows()[0]).getByRole('button', { name: '恢复副本' }));
      expect(screen.getByRole('status').textContent).toContain('恢复会继续');
      if (mode === 'keyboard') fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: '稍后处理' }));
      expect(onClose).toHaveBeenCalledOnce();
      expect(onRestore).toHaveBeenCalledExactlyOnceWith('a');
      expect(onRemove).not.toHaveBeenCalled();
      await act(async () => pending.resolve(undefined));
      expect(screen.queryByRole('status')).toBeNull();
      expect(onRestore).toHaveBeenCalledOnce();
      expect(onRemove).not.toHaveBeenCalled();
    },
  );

  it('locks destructive dismissal and re-entry synchronously before the busy render', async () => {
    const confirmation = deferred<boolean>();
    vi.mocked(confirmDialog).mockReturnValue(confirmation.promise);
    const { rows, onRestore, onRemove, onClose } = setup();
    const remove = within(rows()[0]).getByRole('button', { name: '删除副本' });
    const close = screen.getByRole('button', { name: '稍后处理' });
    act(() => {
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      remove.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(deleteSnapshot).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => confirmation.resolve(false));
    expect(deleteSnapshot).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('separates deletion confirmation from actual deletion and leaves cancelled copies untouched', async () => {
    const confirmation = deferred<boolean>();
    vi.mocked(confirmDialog).mockReturnValue(confirmation.promise);
    const { rows, onRemove, onClose } = setup();
    fireEvent.click(within(rows()[1]).getByRole('button', { name: '删除副本' }));
    expect(screen.getByRole('status').textContent).toContain('等待确认删除「会议记录.md」');
    expect(screen.getByRole('status').textContent).not.toContain('已删除');
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith(
      '永久删除「会议记录.md」的恢复副本和图片？删除后无法恢复，原文件不受影响。',
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(deleteSnapshot).not.toHaveBeenCalled();
    await act(async () => confirmation.resolve(false));
    expect(deleteSnapshot).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: '稍后处理' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('announces delayed deletion only after confirmation and removes only the selected completed copy', async () => {
    const pending = deferred<void>();
    vi.mocked(deleteSnapshot).mockReturnValue(pending.promise);
    const { rows, onRemove, onRestore, onClose } = setup();
    await act(async () =>
      fireEvent.click(within(rows()[1]).getByRole('button', { name: '删除副本' })),
    );
    expect(screen.getByRole('status').textContent).toContain('正在删除「会议记录.md」');
    expect(screen.getByRole('status').textContent).not.toContain('已删除');
    fireEvent.click(within(rows()[0]).getByRole('button', { name: '删除副本' }));
    expect((screen.getByRole('button', { name: '稍后处理' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '稍后处理' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(deleteSnapshot).toHaveBeenCalledExactlyOnceWith('b');
    expect(onRemove).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => pending.resolve(undefined));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('b');
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: '稍后处理' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('reports a missing snapshot without assuring copy retention and unlocks retry after acknowledgment', async () => {
    const pending = deferred<void>();
    const notice = deferred<void>();
    vi.mocked(showMessage).mockReturnValue(notice.promise);
    const { rows, onRestore, onRemove, onClose } = setup();
    onRestore.mockReturnValueOnce(pending.promise);
    await act(async () =>
      fireEvent.click(within(rows()[0]).getByRole('button', { name: '恢复副本' })),
    );
    await act(async () => pending.reject(new Error('snapshot.json not found')));
    expect(screen.getByRole('alert').textContent).toContain('恢复失败');
    expect(screen.getByRole('alert').textContent).not.toMatch(/副本仍保留|副本仍存在|可恢复/);
    expect(screen.getByRole('alert').textContent).toContain('请勿清理应用数据');
    expect(screen.getByRole('alert').textContent).toContain('重新打开「恢复」检查');
    expect(screen.getByRole('alert').textContent).toContain('重试恢复');
    expect(showMessage).toHaveBeenCalledExactlyOnceWith(
      screen.getByRole('alert').textContent,
      'error',
    );
    expect(screen.queryByRole('button', { name: /恢复中|删除中/ })).toBeNull();
    expect(rows()).toHaveLength(2);
    expect(onRemove).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '稍后处理' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => notice.resolve(undefined));
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      (within(rows()[0]).getByRole('button', { name: '恢复副本' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await act(async () =>
      fireEvent.click(within(rows()[0]).getByRole('button', { name: '恢复副本' })),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onRestore).toHaveBeenCalledTimes(2);
  });

  it('reports uncertain partial deletion without promising recovery or automatically replaying deletion', async () => {
    const pending = deferred<void>();
    const notice = deferred<void>();
    vi.mocked(deleteSnapshot).mockReturnValueOnce(pending.promise);
    vi.mocked(showMessage).mockReturnValueOnce(notice.promise);
    const { rows, onRemove, onRestore, onClose } = setup();
    await act(async () =>
      fireEvent.click(within(rows()[0]).getByRole('button', { name: '删除副本' })),
    );
    await act(async () =>
      pending.reject(new Error('snapshot.json removed; attachment cleanup failed')),
    );
    const feedback = screen.getByRole('alert').textContent;
    expect(feedback).toContain('删除未完成');
    expect(feedback).toContain('副本可能已部分删除');
    expect(feedback).toContain('原文件不受影响');
    expect(feedback).toContain('重新打开「恢复」检查');
    expect(feedback).not.toContain('副本仍保留');
    expect(feedback).not.toContain('可恢复');
    expect(screen.queryByRole('button', { name: /恢复中|删除中/ })).toBeNull();
    expect(deleteSnapshot).toHaveBeenCalledExactlyOnceWith('a');
    expect(onRemove).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => notice.resolve(undefined));
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('false');
    const dismiss = screen.getByRole('button', { name: '稍后处理' }) as HTMLButtonElement;
    expect(dismiss.disabled).toBe(false);
    fireEvent.click(dismiss);
    expect(onClose).toHaveBeenCalledOnce();
    expect(deleteSnapshot).toHaveBeenCalledExactlyOnceWith('a');
    expect(onRemove).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('retains each damaged document identity and associates the disabled restore explanation', () => {
    const { rows, onRestore } = setup(entries.map((entry) => ({ ...entry, damaged: true })));
    for (const [index, entry] of entries.entries()) {
      expect(within(rows()[index]).getByText(entry.title)).toBeTruthy();
      const restore = within(rows()[index]).getByRole('button', {
        name: '恢复副本',
      }) as HTMLButtonElement;
      expect(restore.disabled).toBe(true);
      const explanation = document.getElementById(restore.getAttribute('aria-describedby')!);
      expect(explanation?.textContent).toContain('副本不完整，无法恢复');
      expect(rows()[index].contains(explanation)).toBe(true);
      fireEvent.click(restore);
    }
    expect(onRestore).not.toHaveBeenCalled();
    expect(rows()[0].textContent).toContain('C:/notes/a.md');
    expect(rows()[1].textContent).toContain('未保存的新文档');
    expect(screen.getByRole('dialog').getAttribute('aria-describedby')).toBe(
      'recovery-description',
    );
    expect(screen.getByText(/不覆盖原文件/)).toBeTruthy();
  });

  it('keeps keyboard focus inside the dialog and returns it to the opener when dismissed', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = setup();
    const first = within(screen.getByRole('dialog')).getAllByRole('button')[0];
    const last = screen.getByRole('button', { name: '稍后处理' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
