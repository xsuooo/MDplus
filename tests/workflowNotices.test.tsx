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
    const toggle = screen.getByRole('menuitemcheckbox', { name: '恢复上次会话' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(change).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('menuitem', { name: '重试会话恢复' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('can dismiss a failure summary and show a later failed retry without losing its entries', () => {
    const failures = [
      { path: '\\\\?\\C:\\notes\\gone.md', title: 'gone.md', message: '文件不存在' },
    ];
    const retry = vi.fn();
    const view = render(<SessionRestoreNotice failures={failures} busy={false} onRetry={retry} />);
    expect(screen.getByRole('status').textContent).toContain('有 1 个文稿未能恢复');
    expect(screen.getByRole('status').textContent).toContain('C:\\notes\\gone.md');
    fireEvent.click(screen.getByRole('button', { name: '重试恢复' }));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '关闭会话恢复提示' }));
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<SessionRestoreNotice failures={[...failures]} busy={false} onRetry={retry} />);
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<SessionRestoreNotice failures={[...failures]} busy onRetry={retry} />);
    expect(screen.getByRole('status').textContent).toContain('有 1 个文稿未能恢复');
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

  it('announces insertion progress and successful completion without claiming unfinished work succeeded', () => {
    const close = vi.fn();
    const result = { attempted: 3, inserted: 3, failures: [] };
    const view = render(
      <ImageDropNotice result={null} progress={{ completed: 1, total: 3 }} onDismiss={close} />,
    );
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('status').textContent).toContain('正在插入图片，已处理 1 / 3 张');
    expect(screen.queryByRole('button', { name: '关闭图片导入提示' })).toBeNull();
    view.rerender(<ImageDropNotice result={result} progress={null} onDismiss={close} />);
    expect(screen.getByRole('status').textContent).toContain('已插入 3 张图片');
    expect(screen.getByRole('status').textContent).toContain('Ctrl+Z');
    fireEvent.click(screen.getByRole('button', { name: '关闭图片导入提示' }));
    expect(close).toHaveBeenCalledOnce();
    view.rerender(<ImageDropNotice result={null} progress={null} onDismiss={close} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
