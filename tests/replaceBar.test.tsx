// @vitest-environment jsdom
import { useCallback, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchBar } from '../src/components/SearchBar';
import { SourceEditor } from '../src/components/SourceEditor';
import { clearPendingImages } from '../src/lib/imageOps';
import type { SourceEditorApi } from '../src/lib/sourceEditorApi';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/lib/sourcePosition', () => ({
  measureSourceText: (
    _input: HTMLTextAreaElement,
    _text: string,
    measure: (top: (offset: number) => number, lineHeight: number) => void,
  ) => measure((offset) => offset, 1),
  mapSourceScroll: (input: HTMLTextAreaElement) => input.scrollTop,
}));

function Workspace({
  onClose = vi.fn(),
  documentId = 'replace-ui',
  initial = 'Needle needle needle',
}) {
  const [text, setText] = useState(initial);
  const [input, setInput] = useState<HTMLTextAreaElement | null>(null);
  const [api, setApi] = useState<SourceEditorApi | null>(null);
  const registerInput = useCallback(
    (_tabId: string, field: HTMLTextAreaElement | null) => setInput(field),
    [],
  );
  const registerApi = useCallback(
    (_tabId: string, bridge: SourceEditorApi | null) => setApi(bridge),
    [],
  );
  return (
    <>
      <SourceEditor
        tabId="replace-ui"
        value={text}
        onChange={(_tabId, next) => setText(next)}
        onClose={vi.fn()}
        onRegister={registerInput}
        onApi={registerApi}
      />
      <SearchBar
        editor={null}
        documentId={documentId}
        source={{ input, api, text }}
        onClose={onClose}
      />
    </>
  );
}
function query(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '搜索关键词' }), {
    target: { value: text },
  });
}
function openReplace(text = '') {
  fireEvent.click(screen.getByRole('button', { name: '显示替换' }));
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: '替换为' });
  fireEvent.change(input, { target: { value: text } });
  return input;
}
beforeEach(() => vi.useFakeTimers());
const flushSearch = () => act(() => vi.advanceTimersByTime(150));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  clearPendingImages('replace-ui');
});

describe('find and replace controls', () => {
  it('reveals the replacement field, keeps empty deletion enabled, and reports the actual count', () => {
    render(<Workspace />);
    query('needle');
    const replacement = openReplace();
    expect(document.activeElement).toBe(replacement);
    const all = screen.getByRole<HTMLButtonElement>('button', { name: '全部替换' });
    expect(all.disabled).toBe(false);

    fireEvent.click(all);

    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Markdown 源码' }).value).toBe(
      '  ',
    );
    expect(screen.getByRole('status').textContent).toBe('已替换 3 处，跳过 0 处');
    flushSearch();
    expect(screen.getByText('无匹配')).toBeTruthy();
  });

  it('uses Enter for one replacement and Ctrl+Enter for all remaining frozen matches', () => {
    render(<Workspace initial="a a a" />);
    query('a');
    const replacement = openReplace('aa');
    const source = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Markdown 源码' });

    fireEvent.keyDown(replacement, { key: 'Enter' });
    expect(source.value).toBe('aa a a');
    expect(screen.getByRole('status').textContent).toBe('已替换 1 处，跳过 0 处');
    fireEvent.keyDown(replacement, { key: 'Enter', ctrlKey: true });
    expect(source.value).toBe('aaaa aa aa');
    expect(screen.getByRole('status').textContent).toBe('已替换 4 处，跳过 0 处');
  });

  it('shares the case switch with replacement and clears stale feedback on another document', () => {
    const rendered = render(<Workspace />);
    query('Needle');
    fireEvent.click(screen.getByRole('checkbox', { name: '区分大小写' }));
    openReplace('updated');
    fireEvent.click(screen.getByRole('button', { name: '全部替换' }));
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Markdown 源码' }).value).toBe(
      'updated needle needle',
    );
    expect(screen.getByRole('status').textContent).toBe('已替换 1 处，跳过 0 处');

    rendered.rerender(<Workspace documentId="another-document" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('lets Esc close from replacement controls and ignores keys or clicks during composition', () => {
    const onClose = vi.fn();
    render(<Workspace onClose={onClose} />);
    query('needle');
    const replacement = openReplace('中文');
    fireEvent.compositionStart(replacement);
    fireEvent.keyDown(replacement, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(replacement, { key: 'Escape', keyCode: 229 });
    fireEvent.click(screen.getByRole('button', { name: '全部替换' }));
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Markdown 源码' }).value).toBe(
      'Needle needle needle',
    );
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.compositionEnd(replacement);

    fireEvent.keyDown(screen.getByRole('button', { name: '全部替换' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps source undo and redo available after replacement', () => {
    render(<Workspace initial="needle needle" />);
    query('needle');
    openReplace('updated');
    fireEvent.click(screen.getByRole('button', { name: '全部替换' }));
    const source = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Markdown 源码' });
    act(() => source.focus());

    fireEvent.keyDown(source, { key: 'z', ctrlKey: true });
    expect(source.value).toBe('needle needle');
    fireEvent.keyDown(source, { key: 'y', ctrlKey: true });
    expect(source.value).toBe('updated updated');
  });
});
