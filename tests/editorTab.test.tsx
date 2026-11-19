// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorUpdate } from '../src/lib/types';

const editorFactory = vi.hoisted(() => ({
  focus: vi.fn(),
  create: vi.fn((root: HTMLElement) => ({
    action: (run: (ctx: any) => unknown) =>
      run({ get: () => ({ dom: root, focus: editorFactory.focus }) }),
  })),
}));
vi.mock('../src/lib/editor', () => ({
  createEditor: editorFactory.create,
  getCurrentState: (): EditorUpdate => ({
    markdown: '',
    outline: [],
    stats: { chars: 0, words: 0, lines: 1 },
    canUndo: false,
    canRedo: false,
  }),
  getEditorImageReferences: () => new Set<string>(),
}));
vi.mock('@milkdown/react', async () => {
  const React = await import('react');
  return {
    MilkdownProvider: ({ children }: { children: ReactNode }) => children,
    Milkdown: () => null,
    useEditor: (factory: (root: HTMLElement) => object) => {
      const editor = React.useRef<object | null>(null);
      if (!editor.current) editor.current = factory(document.createElement('div'));
      return { get: () => editor.current, loading: false };
    },
  };
});

import { EditorTab } from '../src/components/EditorTab';

afterEach(() => {
  cleanup();
  editorFactory.create.mockClear();
  editorFactory.focus.mockClear();
});

function tabs(active: 'a' | 'b') {
  return (['a', 'b'] as const).map((tabId) => (
    <EditorTab
      key={tabId}
      tabId={tabId}
      initialContent={`# ${tabId}`}
      isNew={false}
      active={active === tabId}
      sourceMode={false}
      onUpdate={() => {}}
      onActivity={() => {}}
      onRegister={() => {}}
    />
  ));
}

describe('EditorTab activation', () => {
  it('focuses a new document when ready without stealing focus from an input', () => {
    const props = {
      tabId: 'new',
      initialContent: '',
      isNew: true,
      active: true,
      sourceMode: false,
      onUpdate: vi.fn(),
      onActivity: vi.fn(),
      onRegister: vi.fn(),
    };
    const view = render(<EditorTab {...props} />);
    expect(editorFactory.focus).toHaveBeenCalledOnce();
    view.unmount();
    editorFactory.focus.mockClear();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    render(<EditorTab {...props} />);
    expect(editorFactory.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it('creates hidden editors only on first activation and retains visited editors', () => {
    const view = render(<>{tabs('a')}</>);
    expect(editorFactory.create).toHaveBeenCalledTimes(1);

    view.rerender(<>{tabs('b')}</>);
    expect(editorFactory.create).toHaveBeenCalledTimes(2);

    view.rerender(<>{tabs('a')}</>);
    expect(editorFactory.create).toHaveBeenCalledTimes(2);
  });
});
