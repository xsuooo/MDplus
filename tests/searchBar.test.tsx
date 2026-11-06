// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchBar } from '../src/components/SearchBar';
import { LIMITS } from '../src/config/constants';

vi.mock('../src/lib/sourcePosition', () => ({
  measureSourceText: (
    _input: HTMLTextAreaElement,
    _value: string,
    measure: (top: (offset: number) => number, lineHeight: number) => void,
  ) => measure((offset) => offset, 1),
}));
afterEach(() => {
  cleanup();
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
    expect(screen.getByText(`${count} 处`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '上一条匹配' }));
    expect(input.selectionStart).toBe((count - 1) * 2);
    expect(input.selectionEnd).toBe((count - 1) * 2 + 1);
    fireEvent.click(screen.getByRole('button', { name: '下一条匹配' }));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(1);
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
    expect(screen.getByText('2 处')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一条匹配' }));
    input.value = 'unrelated';
    view.rerender(
      <SearchBar editor={null} source={{ input, text: input.value }} onClose={onClose} />,
    );
    expect(screen.getByText('无匹配')).toBeTruthy();
    const before = input.selectionStart;
    fireEvent.click(screen.getByRole('button', { name: '下一条匹配' }));
    expect(input.selectionStart).toBe(before);
  });
});
