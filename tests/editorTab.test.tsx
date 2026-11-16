// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorUpdate } from '../src/lib/types';

const editorFactory = vi.hoisted(() => ({ create: vi.fn(() => ({})) }));
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

afterEach(() => editorFactory.create.mockClear());

function tabs(active: 'a' | 'b') {
  return (['a', 'b'] as const).map((tabId) => (
    <EditorTab
      key={tabId}
      tabId={tabId}
      initialContent={`# ${tabId}`}
      active={active === tabId}
      sourceMode={false}
      onUpdate={() => {}}
      onActivity={() => {}}
      onRegister={() => {}}
    />
  ));
}

describe('EditorTab activation', () => {
  it('creates hidden editors only on first activation and retains visited editors', () => {
    const view = render(<>{tabs('a')}</>);
    expect(editorFactory.create).toHaveBeenCalledTimes(1);

    view.rerender(<>{tabs('b')}</>);
    expect(editorFactory.create).toHaveBeenCalledTimes(2);

    view.rerender(<>{tabs('a')}</>);
    expect(editorFactory.create).toHaveBeenCalledTimes(2);
  });
});
