// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RecentMenu } from '../src/components/RecentMenu';
import { SessionRestoreNotice } from '../src/components/SessionRestoreNotice';
import { ImageDropNotice } from '../src/components/ImageDropNotice';

afterEach(cleanup);

describe('workflow controls', () => {
  it('keeps the restore setting available when there are no recent files', () => {
    const change = vi.fn();
    const retry = vi.fn();
    render(
      <RecentMenu
        items={[]}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
        restoreSessionEnabled
        onRestoreSessionChange={change}
        sessionFailureCount={2}
        onRetrySession={retry}
      />,
    );
    const toggle = screen.getByRole('menuitemcheckbox', { name: '启动时打开上次的文档' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(change).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('menuitem', { name: '重新打开失败的文档' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps unavailable document reminders silent across retries and subsequent starts', () => {
    const failures = [
      { path: '\\\\?\\C:\\notes\\gone.md', title: 'gone.md', message: '文件不存在' },
    ];
    const retry = vi.fn();
    const view = render(<SessionRestoreNotice failures={failures} busy={false} onRetry={retry} />);
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<SessionRestoreNotice failures={[...failures]} busy onRetry={retry} />);
    expect(screen.queryByRole('status')).toBeNull();
    view.unmount();
    render(<SessionRestoreNotice failures={failures} busy={false} onRetry={retry} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(failures).toHaveLength(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('retains dismissible feedback for unavailable session metadata', () => {
    const failures = [
      { path: '', title: '上次打开的文档', message: '无法读取文档列表，现有记录仍然保留。' },
    ];
    const retry = vi.fn();
    const view = render(<SessionRestoreNotice failures={failures} busy={false} onRetry={retry} />);
    expect(screen.getByRole('status').textContent).toContain('上次打开的文档列表暂时不可用');
    expect(screen.getByRole('status').textContent).toContain('现有记录仍然保留');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '关闭重新打开提示' }));
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(
      <SessionRestoreNotice
        failures={[...failures, { path: 'C:/notes/gone.md', title: 'gone.md', message: '不存在' }]}
        busy={false}
        onRetry={retry}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<SessionRestoreNotice failures={[...failures]} busy onRetry={retry} />);
    expect(screen.getByRole('status').textContent).toContain('上次打开的文档列表暂时不可用');
    expect(screen.getByRole('button', { name: '正在重试…' }).hasAttribute('disabled')).toBe(true);
  });

  it('reports partial picture success and directs a drop without a document to create/open one', () => {
    const close = vi.fn();
    const view = render(
      <ImageDropNotice
        progress={null}
        result={{
          attempted: 3,
          inserted: 2,
          failures: [{ path: 'C:/images/broken.png', message: '图片无法解码' }],
        }}
        onDismiss={close}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('已插入 2 张图片，1 张未能插入');
    expect(screen.getByRole('status').textContent).toContain('broken.png');
    fireEvent.click(screen.getByRole('button', { name: '关闭图片导入提示' }));
    expect(close).toHaveBeenCalledOnce();
    view.rerender(
      <ImageDropNotice
        progress={null}
        result={{ attempted: 1, inserted: 0, failures: [], reason: 'no-document' }}
        onDismiss={close}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('请先新建或打开文稿');
  });

  it('announces insertion progress and clears the notice after a successful insertion', () => {
    const close = vi.fn();
    const result = { attempted: 3, inserted: 3, failures: [] };
    const view = render(
      <ImageDropNotice result={null} progress={{ completed: 1, total: 3 }} onDismiss={close} />,
    );
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('status').textContent).toContain('正在插入图片，已处理 1 / 3 张');
    expect(screen.queryByRole('button', { name: '关闭图片导入提示' })).toBeNull();
    view.rerender(<ImageDropNotice result={result} progress={null} onDismiss={close} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    view.rerender(<ImageDropNotice result={null} progress={null} onDismiss={close} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
