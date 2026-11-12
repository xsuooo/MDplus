// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDocumentFiles } from '../src/hooks/useDocumentFiles';
import { useDocumentSession } from '../src/hooks/useDocumentSession';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('../src/lib/editor', () => ({ setMarkdown: vi.fn() }));
vi.mock('../src/lib/imageOps', () => ({ clearPendingImages: vi.fn() }));
vi.mock('../src/lib/store', () => ({ getRecentFiles: async () => [] }));

afterEach(cleanup);

function setup() {
  return renderHook(() => {
    const session = useDocumentSession();
    return { session, files: useDocumentFiles(session) };
  });
}

describe('untitled document names', () => {
  it('keeps new document titles distinct after an earlier untitled tab is closed', async () => {
    const hook = setup();
    await act(async () => {
      hook.result.current.files.createDocument('blank');
      hook.result.current.files.createDocument('blank');
    });
    act(() => {
      const firstId = hook.result.current.session.tabsRef.current[0].id;
      hook.result.current.session.removeTab(firstId);
      hook.result.current.files.createDocument('blank');
    });
    const titles = hook.result.current.session.tabsRef.current.map((tab) => tab.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toContain('未命名文档 2.md');
  });

  it('avoids reusing a title still held by a saved document', async () => {
    const hook = setup();
    await act(async () => hook.result.current.files.createDocument('blank'));
    act(() => {
      const savedId = hook.result.current.session.tabsRef.current[0].id;
      hook.result.current.session.updateTab(savedId, {
        path: 'C:/notes/未命名文档.md',
        isNew: false,
      });
      hook.result.current.files.createDocument('basic');
    });
    expect(hook.result.current.session.tabsRef.current.map((tab) => tab.title)).toEqual([
      '未命名文档.md',
      '未命名文档 2.md',
    ]);
  });
});
