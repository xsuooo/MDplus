// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Welcome } from '../src/components/Welcome';
import { RecentMenu } from '../src/components/RecentMenu';
import { displayPath } from '../src/lib/paths';
import type { RecentFile } from '../src/lib/types';

const recent: RecentFile = {
  path: '\\\\?\\C:\\notes\\draft.md',
  name: 'draft.md',
  time: 1,
};

beforeEach(() => {
  const media = new EventTarget();
  Object.defineProperty(media, 'matches', { value: true });
  vi.stubGlobal('matchMedia', () => media);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function welcomeCallbacks() {
  return { onNew: vi.fn(), onOpen: vi.fn(), onExample: vi.fn(), onRecent: vi.fn() };
}

function menuCallbacks() {
  return { onOpen: vi.fn(), onRemove: vi.fn(), onClose: vi.fn() };
}

describe('start and continue writing', () => {
  it.each([
    ['新建空白文稿', 'onNew'],
    ['打开文件', 'onOpen'],
    ['打开示例文档', 'onExample'],
  ] as const)('keeps %s a single-click action', (label, callback) => {
    const callbacks = welcomeCallbacks();
    const { container } = render(<Welcome recents={[]} {...callbacks} />);

    expect(screen.getByRole('heading', { name: '开始写作，或继续文稿。' })).toBeTruthy();
    expect(container.querySelector('.welcome-description, .welcome-footnote')).toBeNull();
    expect(screen.queryByText('新建文稿或打开文件')).toBeNull();
    expect(screen.queryByText('新建空白文稿，或打开已有文件。', { exact: false })).toBeNull();
    expect(screen.queryByText('从最近文件继续写作，也可打开示例文档。')).toBeNull();
    expect(screen.queryByText('新建文稿或打开文件，开始写作。')).toBeNull();
    expect(screen.getByText('也可以把 Markdown 文件拖进窗口打开')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(callbacks[callback]).toHaveBeenCalledOnce();
    for (const [name, handler] of Object.entries(callbacks)) {
      if (name !== callback) expect(handler).not.toHaveBeenCalled();
    }
  });

  it('continues the selected recent file with its exact path and retains the five-file limit', () => {
    const callbacks = welcomeCallbacks();
    const recents = [
      recent,
      ...Array.from({ length: 5 }, (_, index) => ({
        path: 'C:/other-' + index + '/draft.md',
        name: recent.name,
        time: index + 2,
      })),
    ];
    render(<Welcome recents={recents} {...callbacks} />);

    const list = screen.getByRole('region', { name: '最近文件' });
    expect(within(list).getByText('继续写作')).toBeTruthy();
    expect(within(list).getAllByRole('button')).toHaveLength(5);
    const button = within(list).getByRole('button', {
      name: '打开 ' + recent.name + '，' + displayPath(recent.path),
    });
    expect(button.getAttribute('title')).toBe(displayPath(recent.path));
    expect(within(button).getByText('C:\\notes\\')).toBeTruthy();
    fireEvent.click(button);

    expect(callbacks.onRecent).toHaveBeenCalledExactlyOnceWith(recent.path);
    expect(callbacks.onNew).not.toHaveBeenCalled();
    expect(callbacks.onOpen).not.toHaveBeenCalled();
    expect(callbacks.onExample).not.toHaveBeenCalled();
  });

  it('opens a recent menu file in one click without removing its record', () => {
    const callbacks = menuCallbacks();
    render(<RecentMenu items={[recent]} {...callbacks} />);

    const menu = screen.getByRole('menu', { name: '最近文件' });
    const button = within(menu).getByRole('menuitem', {
      name: '打开 ' + recent.name + '，' + displayPath(recent.path),
    });
    expect(button.getAttribute('title')).toBe(displayPath(recent.path));
    expect(within(button).getByText('C:\\notes\\')).toBeTruthy();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);

    expect(callbacks.onOpen).toHaveBeenCalledExactlyOnceWith(recent.path);
    expect(callbacks.onRemove).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });

  it('explains list-only removal accessibly and invokes only the removal callback without confirmation', () => {
    const callbacks = menuCallbacks();
    const confirm = vi.spyOn(window, 'confirm');
    const items = Object.freeze([Object.freeze({ ...recent })]);
    const view = render(<RecentMenu items={[...items]} {...callbacks} />);

    const button = screen.getByRole('button', {
      name: '从最近文件移除 ' + recent.name + '，' + displayPath(recent.path) + '；不会删除文件',
    });
    expect(button.getAttribute('title')).toBe('从最近文件列表移除，不会删除文件');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);

    expect(callbacks.onRemove).toHaveBeenCalledExactlyOnceWith(recent.path);
    expect(callbacks.onOpen).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(items).toEqual([recent]);
    view.rerender(<RecentMenu items={[]} {...callbacks} />);
    expect(screen.getByText('暂无最近文件')).toBeTruthy();
  });

  it('retains session preferences, retry callbacks, and Escape dismissal', () => {
    const callbacks = menuCallbacks();
    const onRestoreSessionChange = vi.fn();
    const onRetrySession = vi.fn();
    const props = {
      ...callbacks,
      onRestoreSessionChange,
      onRetrySession,
      sessionFailureCount: 1,
    };
    const view = render(<RecentMenu items={[]} {...props} />);
    const toggle = screen.getByRole('menuitemcheckbox', { name: '启动时打开上次的文档' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onRestoreSessionChange).toHaveBeenCalledExactlyOnceWith(false);
    fireEvent.click(screen.getByRole('menuitem', { name: '重新打开失败的文档' }));
    expect(onRetrySession).toHaveBeenCalledOnce();

    view.rerender(
      <RecentMenu items={[]} {...props} restoreSessionEnabled={false} sessionRestoreBusy />,
    );
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('menuitem', { name: '正在重试…' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(callbacks.onClose).toHaveBeenCalledExactlyOnceWith();
    expect(callbacks.onOpen).not.toHaveBeenCalled();
    expect(callbacks.onRemove).not.toHaveBeenCalled();
  });
});
