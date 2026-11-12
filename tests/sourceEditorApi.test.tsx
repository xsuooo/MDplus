// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceEditor } from '../src/components/SourceEditor';
import {
  getSourceEditorApi,
  subscribeSourceEditorChanges,
  type SourceEditorApi,
} from '../src/lib/sourceEditorApi';
import { replaceAllSourceMatches, replaceSourceMatch } from '../src/lib/replace';
import { clearPendingImages } from '../src/lib/imageOps';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function mount(value = 'needle needle', active = true) {
  const changed = vi.fn();
  let api: SourceEditorApi | null = null;
  const register = (_tabId: string, next: SourceEditorApi | null) => {
    api = next;
  };
  const rendered = render(
    <SourceEditor
      tabId="source-api-test"
      value={value}
      active={active}
      onChange={changed}
      onClose={vi.fn()}
      onApi={register}
    />,
  );
  const input = rendered.container.querySelector<HTMLTextAreaElement>('textarea')!;
  return { rendered, input, changed, api: api! };
}
afterEach(() => {
  cleanup();
  clearPendingImages('source-api-test');
});

describe('SourceEditor programmatic edits', () => {
  it('uses the current draft before parent props echo, and retains the existing typing history', () => {
    const { input, api, changed } = mount();
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.input(input, { target: { value: 'needle needle typed' }, inputType: 'insertText' });
    expect(api.read().text).toBe('needle needle typed');

    act(() => {
      expect(replaceAllSourceMatches(api, 'needle', 'new', false)).toMatchObject({
        replaced: 2,
        skipped: 0,
      });
    });
    expect(input.value).toBe('new new typed');
    expect(changed).toHaveBeenLastCalledWith('source-api-test', 'new new typed');
    act(() => api.undo());
    expect(input.value).toBe('needle needle typed');
    act(() => api.undo());
    expect(input.value).toBe('needle needle');
    act(() => api.redo());
    act(() => api.redo());
    expect(input.value).toBe('new new typed');
  });

  it('accepts successive operations in one React batch without losing the latest draft or undo selections', () => {
    const { input, api } = mount('abc');
    input.setSelectionRange(3, 3);

    act(() => {
      expect(api.applyEdits([{ from: 3, to: 3, text: 'd' }], { start: 4, end: 4 })).toBe(true);
      expect(api.read()).toEqual({ text: 'abcd', start: 4, end: 4 });
      expect(api.applyEdits([{ from: 4, to: 4, text: 'e' }], { start: 5, end: 5 })).toBe(true);
      expect(api.read()).toEqual({ text: 'abcde', start: 5, end: 5 });
    });
    expect(input.value).toBe('abcde');
    act(() => {
      api.undo();
      expect(api.read()).toEqual({ text: 'abcd', start: 4, end: 4 });
      api.undo();
      expect(api.read()).toEqual({ text: 'abc', start: 3, end: 3 });
      api.redo();
      api.redo();
    });
    expect(input.value).toBe('abcde');
    expect(input.selectionStart).toBe(5);
  });

  it('applies frozen literal matches, including source-only Mermaid and formula text', () => {
    const source = 'A+B a+b\n\n```mermaid\na+b-->A\n```\n\n$a+b$';
    const { input, api } = mount(source);
    act(() => {
      expect(replaceAllSourceMatches(api, 'a+b', '$& a+b', true)).toMatchObject({
        replaced: 3,
        skipped: 0,
      });
    });
    expect(input.value).toBe('A+B $& a+b\n\n```mermaid\n$& a+b-->A\n```\n\n$$& a+b$');
    act(() => api.undo());
    expect(input.value).toBe(source);
  });

  it('allows empty replacement and isolates typing after an all-replace operation', () => {
    const { input, api } = mount('needle middle needle');
    act(() => replaceAllSourceMatches(api, 'needle', '', false));
    expect(input.value).toBe(' middle ');
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.input(input, { target: { value: ' middle after' }, inputType: 'insertText' });

    act(() => api.undo());
    expect(input.value).toBe(' middle ');
    act(() => api.undo());
    expect(input.value).toBe('needle middle needle');
  });

  it('replaces the selected source match and advances past inserted occurrences', () => {
    const { input, api } = mount('needle needle needle');
    input.setSelectionRange(7, 13);
    act(() => {
      expect(replaceSourceMatch(api, 'needle', 'needle needle', false)).toMatchObject({
        replaced: 1,
        skipped: 0,
        nextIndex: 3,
      });
    });
    expect(input.value).toBe('needle needle needle needle');
    expect([input.selectionStart, input.selectionEnd]).toEqual([21, 27]);
  });

  it('validates all offsets atomically and leaves history intact when an edit set is invalid', () => {
    const { input, api, changed } = mount('abcdef');
    const cases = [
      [
        { from: 2, to: 5, text: 'x' },
        { from: 4, to: 6, text: 'y' },
      ],
      [{ from: -1, to: 0, text: 'x' }],
      [{ from: 1.5, to: 2, text: 'x' }],
      [{ from: 0, to: 7, text: 'x' }],
    ];
    act(() => {
      for (const edits of cases) expect(api.applyEdits(edits)).toBe(false);
      expect(api.applyEdits([{ from: 1, to: 2, text: 'x' }], { start: 9, end: 9 })).toBe(false);
      api.undo();
    });
    expect(input.value).toBe('abcdef');
    expect(changed).not.toHaveBeenCalled();
  });

  it('publishes exact separate edits and a mapper for an asynchronous source insertion anchor', () => {
    const { api } = mount('needle middle needle');
    const observed: Array<{
      before: string;
      after: string;
      edits: unknown;
      anchor: number | undefined;
    }> = [];
    const stop = subscribeSourceEditorChanges(api, (before, after, edits, mapOffset) => {
      observed.push({ before, after, edits, anchor: mapOffset?.(10) });
    });
    act(() => replaceAllSourceMatches(api, 'needle', 'n', false));
    expect(observed).toEqual([
      {
        before: 'needle middle needle',
        after: 'n middle n',
        edits: [
          { from: 0, to: 6, text: 'n' },
          { from: 14, to: 20, text: 'n' },
        ],
        anchor: 5,
      },
    ]);
    stop();
    act(() => api.undo());
    expect(observed).toHaveLength(1);
  });

  it('does not interrupt Chinese composition, and the committed text still has one undo step', () => {
    const { input, api } = mount('');
    fireEvent.compositionStart(input);
    fireEvent.input(input, {
      target: { value: 'ni' },
      inputType: 'insertCompositionText',
      isComposing: true,
    });
    act(() => {
      expect(api.applyEdits([{ from: 0, to: 2, text: 'wrong' }])).toBe(false);
      api.undo();
    });
    expect(input.value).toBe('ni');
    fireEvent.input(input, {
      target: { value: '你' },
      inputType: 'insertCompositionText',
      isComposing: true,
    });
    fireEvent.compositionEnd(input);
    expect(input.value).toBe('你');
    act(() => api.undo());
    expect(input.value).toBe('');
    act(() => api.redo());
    expect(input.value).toBe('你');
  });

  it('edits a background source tab without stealing focus and unregisters when closed', () => {
    const { input, api, rendered } = mount('abc', false);
    render(<input aria-label="other tab field" />);
    const other = screen.getByRole('textbox', { name: 'other tab field' });
    other.focus();
    input.scrollTop = 120;
    expect(getSourceEditorApi(input)).toBe(api);
    act(() => {
      expect(api.applyEdits([{ from: 3, to: 3, text: 'd' }])).toBe(true);
    });
    expect(input.value).toBe('abcd');
    expect(input.scrollTop).toBe(120);
    expect(document.activeElement).toBe(other);
    rendered.unmount();
    expect(getSourceEditorApi(input)).toBeUndefined();
    expect(api.applyEdits([{ from: 0, to: 0, text: 'closed' }])).toBe(false);
  });
});
