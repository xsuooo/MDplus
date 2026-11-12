import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { editorViewCtx, type Editor } from '@milkdown/kit/core';
import {
  runSearch,
  stepSearch,
  clearSearch,
  getSearchCount,
  subscribeSearchCount,
  createTextSearch,
  type TextSearchIndex,
} from '../lib/search';
import { measureSourceText } from '../lib/sourcePosition';
import { IconChevronDown, IconChevronUp, IconClose, IconSearch } from './icons';
import { isComposingEvent } from '../lib/shortcuts';
import { useIsPresent } from '../lib/presence';
import {
  replaceAllMatches,
  replaceAllSourceMatches,
  replaceCurrentMatch,
  replaceSourceMatch,
  type ReplaceResult,
} from '../lib/replace';
import { subscribeSourceEditorChanges, type SourceEditorApi } from '../lib/sourceEditorApi';
import '../styles/search.css';

interface SearchBarProps {
  editor: Editor | null;
  source?: { input: HTMLTextAreaElement | null; text: string; api?: SourceEditorApi | null };
  documentId?: string;
  onClose: () => void;
}

export const SearchBar = memo(function SearchBar({
  editor,
  source,
  documentId,
  onClose,
}: SearchBarProps) {
  const [keyword, setKeyword] = useState('');
  const [replacement, setReplacement] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [result, setResult] = useState<ReplaceResult | null>(null);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [count, setCount] = useState(0);
  const previousFocus = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const replaceInput = useRef<HTMLInputElement | null>(null);
  const composing = useRef(false);
  const present = useIsPresent();
  const [sourceIndex, setSourceIndex] = useState(-1);
  const [, refreshSource] = useState(0);
  const nextSourceIndex = useRef<{ text: string; index: number } | null>(null);
  const sourceApi = source?.api;
  const sourceText = sourceApi?.read().text ?? source?.text;
  const sourceMode = Boolean(source);
  const [sourceMatches, setSourceMatches] = useState(() =>
    createTextSearch(sourceText ?? '', '', false),
  );
  const [searchPending, setSearchPending] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushSearch = useCallback((): TextSearchIndex | null => {
    clearTimeout(searchTimer.current);
    searchTimer.current = undefined;
    setSearchPending(false);
    const text = sourceText ?? '';
    if (sourceMode) {
      const index = createTextSearch(text, keyword, caseSensitive);
      setSourceMatches(index);
      return index;
    }
    if (editor) runSearch(editor, keyword, caseSensitive);
    return null;
  }, [caseSensitive, editor, keyword, sourceMode, sourceText]);
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!present) {
      setSearchPending(false);
      return;
    }
    setSearchPending(true);
    searchTimer.current = setTimeout(flushSearch, 150);
    return () => clearTimeout(searchTimer.current);
  }, [flushSearch, present]);
  const total = source ? sourceMatches.count : count;

  useEffect(() => {
    const next = nextSourceIndex.current;
    nextSourceIndex.current = null;
    setSourceIndex(next && next.text === sourceText ? next.index : -1);
  }, [sourceText]);

  useEffect(() => {
    nextSourceIndex.current = null;
    setSourceIndex(-1);
    setResult(null);
  }, [keyword, caseSensitive, replacement, documentId]);

  useEffect(() => {
    if (!sourceApi || !present) return;
    return subscribeSourceEditorChanges(sourceApi, () => refreshSource((version) => version + 1));
  }, [sourceApi, present]);

  useEffect(() => {
    if (!present) {
      setKeyword('');
      setReplacement('');
      setReplaceOpen(false);
      setResult(null);
      setCaseSensitive(false);
      setCount(0);
      return;
    }
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchInput.current?.focus({ preventScroll: true });
    const unsubscribe = editor ? subscribeSearchCount(editor, setCount) : undefined;
    return () => {
      unsubscribe?.();
      if (editor) clearSearch(editor);
      if (
        previousFocus.current?.isConnected &&
        (document.activeElement?.closest('.searchbar') || document.activeElement === document.body)
      ) {
        const view = editor?.action((ctx) => ctx.get(editorViewCtx));
        if (view?.dom === previousFocus.current) {
          if (!view.isDestroyed) view.focus();
        } else previousFocus.current.focus({ preventScroll: true });
      }
    };
  }, [editor, present]);

  useEffect(() => {
    if (replaceOpen && present) replaceInput.current?.focus({ preventScroll: true });
  }, [replaceOpen, present]);

  const step = (dir: 1 | -1) => {
    if (!keyword) return;
    const fresh = flushSearch();
    if (source) {
      const input = source.input;
      const text = source.api?.read().text ?? source.text;
      const matches =
        fresh && text === sourceText ? fresh : createTextSearch(text, keyword, caseSensitive);
      if (!input?.isConnected || !matches.count) return;
      const next =
        sourceIndex < 0
          ? dir === 1
            ? 0
            : matches.count - 1
          : (sourceIndex + dir + matches.count) % matches.count;
      const match = matches.at(next);
      if (!match) return;
      setSourceIndex(next);
      input.setSelectionRange(match.from, match.to);
      measureSourceText(input, text, (top, lineHeight) => {
        const first = top(match.from);
        const last = top(match.to - 1) + lineHeight;
        if (first < input.scrollTop || last > input.scrollTop + input.clientHeight) {
          input.scrollTop = Math.max(0, first - input.clientHeight / 3);
        }
      });
      return;
    }
    if (!editor) return;
    stepSearch(editor, dir);
    setCount(getSearchCount(editor));
  };

  const replace = (all: boolean) => {
    if (!present || !keyword || composing.current) return;
    flushSearch();
    let outcome: ReplaceResult;
    if (source) {
      if (!source.api) {
        setResult({ replaced: 0, skipped: 0, reason: 'unavailable' });
        return;
      }
      outcome = all
        ? replaceAllSourceMatches(source.api, keyword, replacement, caseSensitive)
        : replaceSourceMatch(source.api, keyword, replacement, caseSensitive, sourceIndex);
      if (outcome.nextIndex !== undefined) {
        setSourceIndex(outcome.nextIndex);
        const text = source.api.read().text;
        if (outcome.replaced) nextSourceIndex.current = { text, index: outcome.nextIndex };
        else {
          const match = createTextSearch(text, keyword, caseSensitive).at(outcome.nextIndex);
          if (match) source.input?.setSelectionRange(match.from, match.to);
        }
      }
      refreshSource((version) => version + 1);
    } else {
      if (!editor) return;
      outcome = all
        ? replaceAllMatches(editor, keyword, replacement, caseSensitive)
        : replaceCurrentMatch(editor, keyword, replacement, caseSensitive);
      setCount(getSearchCount(editor));
    }
    setResult(outcome);
  };

  const canReplace = Boolean(keyword && (searchPending || total) && (source ? source.api : editor));
  const feedback = result
    ? result.reason === 'unavailable'
      ? '当前无法替换，请结束输入后重试'
      : `${result.reason === 'unchanged' ? '文本未变化；' : ''}已替换 ${result.replaced} 处，跳过 ${result.skipped} 处${result.skipped ? '（格式不一致）' : ''}`
    : '';

  return (
    <div
      className="searchbar searchbar-replace"
      role="search"
      aria-label="搜索当前文档"
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || composing.current || isComposingEvent(event.nativeEvent))
          return;
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="searchbar-row">
        <button
          className="search-btn search-replace-toggle"
          onClick={() => setReplaceOpen((open) => !open)}
          aria-label={replaceOpen ? '隐藏替换' : '显示替换'}
          aria-expanded={replaceOpen}
          title={replaceOpen ? '隐藏替换' : '显示替换'}
        >
          <IconChevronDown size={15} aria-hidden="true" />
        </button>
        <div className="search-field">
          <IconSearch size={16} aria-hidden="true" />
          <input
            ref={searchInput}
            className="search-input"
            aria-label="搜索关键词"
            placeholder="搜索当前文档…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.defaultPrevented || composing.current || isComposingEvent(e.nativeEvent))
                return;
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <label className="search-case" title="区分大小写">
            <input
              type="checkbox"
              aria-label="区分大小写"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            <span aria-hidden="true">Aa</span>
          </label>
        </div>
        <div className="search-matches">
          <span className="search-count" aria-live="polite">
            {keyword ? (searchPending ? '搜索中…' : total > 0 ? `${total} 处` : '无匹配') : ''}
          </span>
          <div className="search-navigation">
            <button
              className="search-btn"
              disabled={!keyword || (!searchPending && total === 0)}
              onClick={() => step(-1)}
              title="上一条 (Shift+Enter)"
              aria-label="上一条匹配"
            >
              <IconChevronUp size={15} aria-hidden="true" />
            </button>
            <button
              className="search-btn"
              disabled={!keyword || (!searchPending && total === 0)}
              onClick={() => step(1)}
              title="下一条 (Enter)"
              aria-label="下一条匹配"
            >
              <IconChevronDown size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        <button
          className="search-btn search-close"
          onClick={onClose}
          title="关闭 (Esc)"
          aria-label="关闭搜索"
        >
          <IconClose size={15} aria-hidden="true" />
        </button>
      </div>
      {replaceOpen && (
        <div className="search-replace-row" role="group" aria-label="替换当前文档">
          <div className="search-field search-replace-field">
            <span className="search-replace-label" aria-hidden="true">
              替换为
            </span>
            <input
              ref={replaceInput}
              className="search-replace-input"
              aria-label="替换为"
              placeholder="留空以删除"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.defaultPrevented ||
                  composing.current ||
                  isComposingEvent(event.nativeEvent)
                )
                  return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  replace((event.ctrlKey || event.metaKey) && !event.altKey);
                }
              }}
            />
          </div>
          <button
            className="search-action"
            disabled={!canReplace}
            onClick={() => replace(false)}
            title="替换当前匹配 (Enter)"
          >
            替换
          </button>
          <button
            className="search-action search-action-primary"
            disabled={!canReplace}
            onClick={() => replace(true)}
            title="替换全部匹配 (Ctrl+Enter)"
          >
            全部替换
          </button>
        </div>
      )}
      {replaceOpen && feedback && (
        <div className="search-replace-result" role="status" aria-live="polite">
          {feedback}
        </div>
      )}
    </div>
  );
});
