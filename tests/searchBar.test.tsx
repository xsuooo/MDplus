// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { SearchBar } from '../src/components/SearchBar';
import { LIMITS } from '../src/config/constants';
import { searchPlugin, searchPluginKey } from '../src/lib/search';

vi.mock('../src/lib/sourcePosition', () => ({
  measureSourceText: (
    _input: HTMLTextAreaElement,
    _value: string,
    measure: (top: (offset: number) => number, lineHeight: number) => void,
  ) => measure((offset) => offset, 1),
}));
const editorViews: EditorView[] = [];
function createSearchEditor(text: string) {
  const schema = new Schema({
    nodes: {
      doc: { content: 'paragraph+' },
      paragraph: { content: 'text*', toDOM: () => ['p', 0] },
      text: {},
    },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: schema.node('doc', null, schema.node('paragraph', null, schema.text(text))),
      plugins: [searchPlugin],
    }),
  });
  editorViews.push(view);
  const editor = {
    action: <T,>(fn: (ctx: Ctx) => T): T => fn({ get: () => view } as unknown as Ctx),
  } as Editor;
  return { editor, view };
}
beforeEach(() => vi.useFakeTimers());
const flushSearch = () => act(() => vi.advanceTimersByTime(150));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const view of editorViews.splice(0)) {
    const host = view.dom.parentElement;
    view.destroy();
    host?.remove();
  }
  document.querySelectorAll('textarea').forEach((input) => input.remove());
});

describe('source search navigation with sparse matches', () => {
  it('counts and reaches hits outside the rendered-editor highlight limit', () => {
    const count = LIMITS.searchHighlightMatches * 3;
    const input = document.createElement('textarea');
    input.value = 'a '.repeat(count);
    document.body.append(input);
    render(<SearchBar editor={null} source={{ input, text: input.value }} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索关键词' }), {
      target: { value: 'a' },
    });
    flushSearch();
    expect(screen.getByText(`${count} 处`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '上一条匹配' }));
    expect(input.selectionStart).toBe((count - 1) * 2);
    expect(input.selectionEnd).toBe((count - 1) * 2 + 1);
    fireEvent.click(screen.getByRole('button', { name: '下一条匹配' }));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(1);
  });

  it('flushes a pending source query before navigation', () => {
    const input = document.createElement('textarea');
    input.value = 'needle needle';
    document.body.append(input);
    render(<SearchBar editor={null} source={{ input, text: input.value }} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索关键词' }), {
      target: { value: 'needle' },
    });
    expect(screen.getByText('搜索中…')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '下一条匹配' }));

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(6);
    expect(screen.getByText('2 处')).toBeTruthy();
  });

  it('invalidates the index and current hit when the source text changes', () => {
    const input = document.createElement('textarea');
    input.value = 'needle needle';
    document.body.append(input);
    const onClose = vi.fn();
    const view = render(
      <SearchBar editor={null} source={{ input, text: input.value }} onClose={onClose} />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: '搜索关键词' }), {
      target: { value: 'needle' },
    });
    flushSearch();
    expect(screen.getByText('2 处')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一条匹配' }));
    input.value = 'unrelated';
    view.rerender(
      <SearchBar editor={null} source={{ input, text: input.value }} onClose={onClose} />,
    );
    flushSearch();
    expect(screen.getByText('无匹配')).toBeTruthy();
    const before = input.selectionStart;
    fireEvent.click(screen.getByRole('button', { name: '下一条匹配' }));
    expect(input.selectionStart).toBe(before);
  });
});

describe('search across editor changes', () => {
  it('reapplies the source query and case preference when returning to the rendered editor', () => {
    const input = document.createElement('textarea');
    input.value = 'Needle needle';
    document.body.append(input);
    const { editor, view: renderedView } = createSearchEditor(input.value);
    const onClose = vi.fn();
    const search = render(
      <SearchBar editor={null} source={{ input, text: input.value }} onClose={onClose} />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: '搜索关键词' }), {
      target: { value: 'Needle' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    flushSearch();
    expect(screen.getByText('1 处')).toBeTruthy();

    search.rerender(<SearchBar editor={editor} onClose={onClose} />);
    flushSearch();

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '搜索关键词' }).value).toBe(
      'Needle',
    );
    expect(screen.getByText('1 处')).toBeTruthy();
    const state = searchPluginKey.getState(renderedView.state)!;
    expect(state.keyword).toBe('Needle');
    expect(state.caseSensitive).toBe(true);
    expect(state.decor.find()).toHaveLength(1);
    expect(renderedView.state.doc.textContent).toBe(input.value);
  });

  it('applies an existing query when the rendered editor finishes initializing', () => {
    const onClose = vi.fn();
    const search = render(<SearchBar editor={null} onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索关键词' }), {
      target: { value: 'needle' },
    });
    const { editor, view } = createSearchEditor('Needle needle');

    search.rerender(<SearchBar editor={editor} onClose={onClose} />);
    flushSearch();

    expect(screen.getByText('2 处')).toBeTruthy();
    expect(searchPluginKey.getState(view.state)!.decor.find()).toHaveLength(2);
  });
});

describe('search focus restoration', () => {
  it('restores the selected occurrence through the rendered editor focus API', () => {
    const { editor, view } = createSearchEditor('prefix needle suffix');
    view.focus();
    const search = render(<SearchBar editor={editor} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索关键词' }), {
      target: { value: 'needle' },
    });
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 14)));
    });
    expect(document.activeElement?.className).toBe('search-input');

    search.unmount();

    expect(document.activeElement).toBe(view.dom);
    expect(view.state.selection.from).toBe(8);
    expect(view.state.selection.to).toBe(14);
    expect(document.getSelection()?.toString()).toBe('needle');
    expect(view.state.doc.textContent).toBe('prefix needle suffix');
  });
});
