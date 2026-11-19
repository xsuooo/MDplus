// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDocumentFiles } from '../src/hooks/useDocumentFiles';
import { useWorkspace } from '../src/hooks/useWorkspace';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('../src/lib/editor', () => ({ setMarkdown: vi.fn() }));
vi.mock('../src/lib/imageOps', () => ({ clearPendingImages: vi.fn() }));
vi.mock('../src/lib/store', () => ({ getRecentFiles: async () => [] }));

afterEach(cleanup);

function setup() {
  return renderHook(() => {
    const workspace = useWorkspace();
    return { workspace, files: useDocumentFiles(workspace) };
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
      const firstId = hook.result.current.workspace.tabsRef.current[0].id;
      hook.result.current.workspace.removeTab(firstId);
      hook.result.current.files.createDocument('blank');
    });
    const titles = hook.result.current.workspace.tabsRef.current.map((tab) => tab.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toContain('未命名文档 2.md');
  });

  it('avoids reusing a title still held by a saved document', async () => {
    const hook = setup();
    await act(async () => hook.result.current.files.createDocument('blank'));
    act(() => {
      const savedId = hook.result.current.workspace.tabsRef.current[0].id;
      hook.result.current.workspace.updateTab(savedId, {
        path: 'C:/notes/未命名文档.md',
        isNew: false,
      });
      hook.result.current.files.createDocument('blank');
    });
    expect(hook.result.current.workspace.tabsRef.current.map((tab) => tab.title)).toEqual([
      '未命名文档.md',
      '未命名文档 2.md',
    ]);
  });

  it('opens examples as distinct unsaved documents without replacing an existing draft', async () => {
    const hook = setup();
    await act(async () => {
      hook.result.current.files.createDocument('blank');
      hook.result.current.files.createDocument('basic');
      hook.result.current.files.createDocument('basic');
    });
    const tabs = hook.result.current.workspace.tabsRef.current;
    expect(tabs.map((tab) => tab.title)).toEqual([
      '未命名文档.md',
      'Markdown 示例.md',
      'Markdown 示例 2.md',
    ]);
    expect(tabs[0].markdown).toBe('');
    expect(tabs[1]).toMatchObject({ isNew: true, path: null });
    expect(tabs[1].markdown).toContain('# Markdown 示例');
  });
});
