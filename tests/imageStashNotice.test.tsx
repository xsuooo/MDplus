// @vitest-environment jsdom
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => path.win32.join(...parts),
  dirname: async (file: string) => path.win32.dirname(file),
}));

import { ImageStashNotice } from '../src/components/ImageStashNotice';
import { clearPendingImages, prepareImageReferences } from '../src/lib/imageOps';
import { C, both, createNative, notePath, one } from './imageStashNative';

const three = `${both}\n\n![c](./img/c.png)`;
let native: ReturnType<typeof createNative>;
let tabs: string[];
let sequence = 0;

function openTab(): string {
  const tab = `stash-notice-${++sequence}`;
  tabs.push(tab);
  return tab;
}

/** Prepares and publishes the tab's whole text, as the app does after an edit. */
async function prepare(tab: string, markdown: string) {
  await act(async () => {
    const prepared = await prepareImageReferences(tab, markdown, notePath);
    expect(prepared.commit()).toBe(true);
  });
}

const notice = () => screen.queryByRole('status');
const text = () => screen.getByRole('status').textContent;

beforeEach(() => {
  vi.useFakeTimers();
  tabs = [];
  native = createNative();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(native.invoke);
});

afterEach(() => {
  cleanup();
  for (const tab of tabs) clearPendingImages(tab);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('the notice for images a full stash left in their files', () => {
  it('stays hidden without a tab and while every image has a preview', async () => {
    const tab = openTab();
    await prepare(tab, both);

    const view = render(<ImageStashNotice tabId={null} />);
    expect(notice()).toBeNull();

    view.rerender(<ImageStashNotice tabId={tab} />);
    expect(notice()).toBeNull();
  });

  it('explains the missing preview, without a dialog, once the stash is full', async () => {
    const tab = openTab();
    render(<ImageStashNotice tabId={tab} />);
    await prepare(tab, one);
    expect(notice()).toBeNull();

    native.state.full = true;
    await prepare(tab, both);

    expect(text()).toBe(
      '1 张图片暂时无法预览。文字可以正常保存，原图片不会被改动。关闭其他含图片的文档后，再编辑或保存以恢复预览。',
    );
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('counts every image left in its file', async () => {
    const tab = openTab();
    native.state.full = true;
    await prepare(tab, both);

    render(<ImageStashNotice tabId={tab} />);

    expect(text()).toContain('2 张图片暂时无法预览。');
  });

  it('disappears once a later preparation admits the image', async () => {
    const tab = openTab();
    render(<ImageStashNotice tabId={tab} />);
    native.state.full = true;
    await prepare(tab, both);
    expect(text()).toContain('2 张图片暂时无法预览');

    native.state.full = false;
    await prepare(tab, both);

    expect(notice()).toBeNull();
  });

  it('disappears when the image leaves the text while the stash is still full', async () => {
    const tab = openTab();
    render(<ImageStashNotice tabId={tab} />);
    await prepare(tab, one);
    native.state.full = true;
    await prepare(tab, both);
    expect(text()).toContain('1 张图片暂时无法预览');

    await prepare(tab, one);

    expect(notice()).toBeNull();
  });

  it('stays closed for the occurrence it was closed in and returns for a later one', async () => {
    const tab = openTab();
    const other = openTab();
    const view = render(<ImageStashNotice tabId={tab} />);
    await prepare(tab, one);
    native.state.full = true;
    await prepare(tab, both);

    fireEvent.click(screen.getByRole('button', { name: '关闭图片预览提示' }));
    expect(notice()).toBeNull();

    await prepare(tab, both);
    expect(notice()).toBeNull();
    view.rerender(<ImageStashNotice tabId={other} />);
    view.rerender(<ImageStashNotice tabId={tab} />);
    expect(notice()).toBeNull();

    native.state.full = false;
    await prepare(tab, both);
    expect(notice()).toBeNull();

    native.state.full = true;
    native.files.set('C:\\notes\\img\\c.png', C);
    await prepare(tab, three);
    expect(text()).toContain('1 张图片暂时无法预览');
  });

  it('follows the active tab', async () => {
    const first = openTab();
    const second = openTab();
    native.state.full = true;
    await prepare(first, one);
    await prepare(second, both);

    const view = render(<ImageStashNotice tabId={first} />);
    expect(text()).toContain('1 张图片暂时无法预览');

    view.rerender(<ImageStashNotice tabId={second} />);
    expect(text()).toContain('2 张图片暂时无法预览');

    // The subscription moved with the tab: only the active tab's changes are shown.
    native.files.set('C:\\notes\\img\\c.png', C);
    await prepare(first, three);
    expect(text()).toContain('2 张图片暂时无法预览');
    await prepare(second, one);
    expect(text()).toContain('1 张图片暂时无法预览');

    view.rerender(<ImageStashNotice tabId={first} />);
    expect(text()).toContain('3 张图片暂时无法预览');

    view.rerender(<ImageStashNotice tabId={null} />);
    expect(notice()).toBeNull();
  });

  it("disappears when the tab's images are cleared", async () => {
    const tab = openTab();
    render(<ImageStashNotice tabId={tab} />);
    native.state.full = true;
    await prepare(tab, one);
    expect(text()).toContain('1 张图片暂时无法预览');

    act(() => clearPendingImages(tab));

    expect(notice()).toBeNull();
  });
});
