import { memo, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { pasteSourceImage } from '../lib/sourcePaste';
import { isComposingEvent } from '../lib/shortcuts';
import { IconCode } from './icons';

interface SourceEditorProps {
  tabId: string;
  value: string;
  onChange: (text: string) => void;
  onClose: () => void;
  onImagePaste?: (tabId: string, file: File) => Promise<string>;
}

interface Snapshot {
  text: string;
  start: number;
  end: number;
}

/** 撤销栈上限:源码模式通常只改几段文字,200 条足够且不会无限吃内存 */
const HISTORY_LIMIT = 200;
/** 连续输入合并成一个撤销步骤的时间窗口(毫秒) */
const COALESCE_MS = 400;

/**
 * 源码模式:一个全屏覆盖的 Markdown 源文本编辑区。
 *
 * 本地草稿区分父组件回声和外部替换,文本输入与程序化图片粘贴共用撤销栈。
 */
export const SourceEditor = memo(function SourceEditor({ tabId, value, onChange, onClose, onImagePaste }: SourceEditorProps) {
  const generation = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState(value);
  // 最近一次推给父组件的文本:用来区分「自己的回声」与「真正的外部修改」
  const pushed = useRef(value);
  const history = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const lastPushAt = useRef(0);
  const composing = useRef(false);
  const lastInputType = useRef('');
  const selectionRef = useRef({ start: 0, end: 0 });
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);

  useLayoutEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [tabId, value]);

  // 外部修改(切换标签、Milkdown 同步、磁盘重载)才回灌到本地草稿
  useLayoutEffect(() => {
    if (value === pushed.current) return;
    pushed.current = value;
    setDraft(value);
    history.current = [];
    future.current = [];
    lastPushAt.current = 0;
    lastInputType.current = '';
    pendingSelection.current = null;
    selectionRef.current = { start: 0, end: 0 };
  }, [value]);

  // 撤销后把光标放回快照位置
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const target = pendingSelection.current;
    if (!el || !target) return;
    pendingSelection.current = null;
    el.setSelectionRange(target.start, target.end);
    selectionRef.current = target;
  }, [draft]);

  const currentSnapshot = (): Snapshot => ({
    text: draft,
    start: selectionRef.current.start,
    end: selectionRef.current.end,
  });

  const pushHistory = () => {
    const now = Date.now();
    const coalesce = history.current.length > 0 && now - lastPushAt.current < COALESCE_MS;
    lastPushAt.current = now;
    if (coalesce) return;
    history.current.push(currentSnapshot());
    if (history.current.length > HISTORY_LIMIT) history.current.shift();
  };

  const applySnapshot = (snapshot: Snapshot) => {
    generation.current += 1;
    pushed.current = snapshot.text;
    pendingSelection.current = { start: snapshot.start, end: snapshot.end };
    setDraft(snapshot.text);
    onChange(snapshot.text);
  };

  const handleUndo = () => {
    let snapshot = history.current.pop();
    // 取消组字可能留下同文本快照,不能让下一次撤销变成无动作。
    while (snapshot?.text === pushed.current) snapshot = history.current.pop();
    if (!snapshot) return;
    future.current.push(currentSnapshot());
    lastPushAt.current = 0;
    applySnapshot(snapshot);
  };

  const handleRedo = () => {
    const snapshot = future.current.pop();
    if (!snapshot) return;
    history.current.push(currentSnapshot());
    lastPushAt.current = 0;
    applySnapshot(snapshot);
  };

  const handleChange = (next: string, inputType = '') => {
    if (next === pushed.current) return;
    if (!composing.current) {
      if (inputType !== lastInputType.current || !['insertText', 'deleteContentBackward', 'deleteContentForward'].includes(inputType)) {
        lastPushAt.current = 0;
      }
      pushHistory();
    }
    lastInputType.current = inputType;
    future.current = [];
    pushed.current = next;
    generation.current += 1;
    setDraft(next);
    onChange(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.defaultPrevented || composing.current || isComposingEvent(event.nativeEvent)) return;
    rememberSelection();
    const mod = event.ctrlKey || event.metaKey;
    // Alt 组合(AltGr 输入)不拦截
    if (!mod || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      handleRedo();
      return;
    }
    if (key === 'z') {
      event.preventDefault();
      handleUndo();
    }
  };

  const rememberSelection = () => {
    const el = textareaRef.current;
    if (!el) return;
    if (selectionRef.current.start !== el.selectionStart || selectionRef.current.end !== el.selectionEnd) {
      lastPushAt.current = 0;
      selectionRef.current = { start: el.selectionStart, end: el.selectionEnd };
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onImagePaste) return;
    const current = generation.current;
    rememberSelection();
    void pasteSourceImage(event, event.currentTarget, (file) => onImagePaste(tabId, file), (text, caret) => {
      handleChange(text, 'insertFromPaste');
      pendingSelection.current = { start: caret, end: caret };
    },
      () => generation.current === current);
  };

  return (
    <div className="source-editor" aria-label="Markdown 源码编辑">
      <div className="source-editor-head">
        <div className="source-editor-title"><IconCode size={15} /> <span>源码模式</span></div>
        <button className="source-editor-close" onClick={onClose} title="返回编辑模式" aria-label="返回编辑模式">
          完成
        </button>
      </div>
      <textarea
        ref={textareaRef}
        className="source-textarea"
        value={draft}
        onChange={(e) => {
          handleChange(e.target.value, (e.nativeEvent as InputEvent).inputType);
          selectionRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
        }}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          rememberSelection();
          lastPushAt.current = 0;
          pushHistory();
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          handleChange(event.currentTarget.value, 'insertCompositionText');
          composing.current = false;
          lastPushAt.current = 0;
        }}
        onSelect={rememberSelection}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        onPaste={handlePaste}
        spellCheck={false}
        aria-label="Markdown 源码"
        autoFocus
      />
    </div>
  );
});
