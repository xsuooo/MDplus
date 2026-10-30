import { memo, useEffect, useRef, useState } from 'react';
import type { Editor } from '@milkdown/kit/core';
import {
  runSearch,
  stepSearch,
  clearSearch,
  getSearchCount,
  subscribeSearchCount,
} from '../lib/search';
import { IconChevronDown, IconChevronUp, IconClose, IconSearch } from './icons';
import { isComposingEvent } from '../lib/shortcuts';

interface SearchBarProps {
  editor: Editor | null;
  onClose: () => void;
}

export const SearchBar = memo(function SearchBar({ editor, onClose }: SearchBarProps) {
  const [keyword, setKeyword] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [count, setCount] = useState(0);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const input = document.querySelector<HTMLInputElement>('.search-input');
    input?.focus();
    const unsubscribe = editor ? subscribeSearchCount(editor, setCount) : undefined;
    return () => {
      unsubscribe?.();
      if (editor) clearSearch(editor);
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, [editor]);

  const apply = (value: string, cs: boolean) => {
    setKeyword(value);
    if (!editor) return;
    runSearch(editor, value, cs);
    setCount(getSearchCount(editor));
  };

  const step = (dir: 1 | -1) => {
    if (!editor || !keyword) return;
    stepSearch(editor, dir);
    setCount(getSearchCount(editor));
  };

  return (
    <div className="searchbar" role="search" aria-label="搜索当前文档">
      <IconSearch size={15} />
      <input
        className="search-input"
        aria-label="搜索关键词"
        placeholder="搜索当前文档…"
        value={keyword}
        onChange={(e) => apply(e.target.value, caseSensitive)}
        onKeyDown={(e) => {
          if (e.defaultPrevented || isComposingEvent(e.nativeEvent)) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <label className="search-case" title="区分大小写">
        <input
          type="checkbox"
          checked={caseSensitive}
          onChange={(e) => {
            const cs = e.target.checked;
            setCaseSensitive(cs);
            apply(keyword, cs);
          }}
        />
        <span>Aa</span>
      </label>
      <span className="search-count" aria-live="polite">
        {keyword && count > 0 ? `${count} 处` : keyword ? '无匹配' : ''}
      </span>
      <button className="search-btn" onClick={() => step(-1)} title="上一条 (Shift+Enter)" aria-label="上一条匹配">
        <IconChevronUp size={14} />
      </button>
      <button className="search-btn" onClick={() => step(1)} title="下一条 (Enter)" aria-label="下一条匹配">
        <IconChevronDown size={14} />
      </button>
      <button className="search-btn" onClick={onClose} title="关闭 (Esc)" aria-label="关闭搜索">
        <IconClose size={13} />
      </button>
    </div>
  );
});
