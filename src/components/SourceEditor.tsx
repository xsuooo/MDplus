import { LIMITS, SOURCE_HISTORY_COALESCE_MS } from '../config/constants';
import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { pasteSourceImage } from '../lib/sourcePaste';
import { isComposingEvent } from '../lib/shortcuts';
import { IconCode } from './icons';
import { mapTextOffset } from '../lib/textPosition';
import { mapSourceScroll } from '../lib/sourcePosition';
import {
  mapSourceEditOffset,
  prepareSourceEdits,
  publishSourceEditorChange,
  registerSourceEditorApi,
  type SourceEditorApi,
  type SourceSelection,
  type SourceTextEdit,
} from '../lib/sourceEditorApi';
import {
  getImageUrls,
  mapImageOffset,
  rewriteImageReferences,
  type PendingImageReference,
} from '../lib/imagePaths';
import {
  imageIdentityReferences,
  imageSourceReferences,
  getPendingImages,
  imageReferencesChanged,
  registerImageReachability,
  settleImageInsertion,
} from '../lib/imageOps';

interface SourceEditorProps {
  tabId: string;
  value: string;
  onChange: (tabId: string, text: string) => void;
  onClose: () => void;
  onImagePaste?: (tabId: string, file: File) => Promise<string>;
  active?: boolean;
  onRegister?: (tabId: string, input: HTMLTextAreaElement | null) => void;
  onApi?: (tabId: string, api: SourceEditorApi | null) => void;
  imageRewrites?: PendingImageReference[];
}

interface Snapshot {
  text: string;
  start: number;
  end: number;
}
function rewriteSnapshot(snapshot: Snapshot, references: PendingImageReference[]): Snapshot {
  return {
    text: rewriteImageReferences(snapshot.text, references),
    start: mapImageOffset(snapshot.text, references, snapshot.start),
    end: mapImageOffset(snapshot.text, references, snapshot.end),
  };
}

/** 撤销栈上限:源码模式通常只改几段文字,200 条足够且不会无限吃内存 */
const HISTORY_LIMIT = LIMITS.sourceHistory;
/** 连续输入合并成一个撤销步骤的时间窗口(毫秒) */
const COALESCE_MS = SOURCE_HISTORY_COALESCE_MS;

/**
 * 源码模式:一个全屏覆盖的 Markdown 源文本编辑区。
 *
 * 本地草稿区分父组件回声和外部替换,文本输入与程序化图片粘贴共用撤销栈。
 */
export const SourceEditor = memo(function SourceEditor({
  tabId,
  value,
  onChange,
  onClose,
  onImagePaste,
  active = true,
  onRegister,
  onApi,
  imageRewrites,
}: SourceEditorProps) {
  const generation = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState(value);
  // 最近一次推给父组件的文本:用来区分「自己的回声」与「真正的外部修改」
  const pushed = useRef(value);
  const history = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const snapshotImageUrls = useRef(new WeakMap<Snapshot, readonly string[]>());
  const lastPushAt = useRef(0);
  const composing = useRef(false);
  const lastInputType = useRef('');
  const selectionRef = useRef({ start: 0, end: 0 });
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const scroll = useRef({ top: 0, left: 0 });
  const direction = useRef<'forward' | 'backward' | 'none'>('none');
  const lastRewrites = useRef(imageRewrites);
  const restoreScroll = useRef(false);
  const apiMethods = useRef<SourceEditorApi | null>(null);
  const api = useRef<SourceEditorApi | null>(null);
  if (!api.current) {
    api.current = {
      read: () => apiMethods.current!.read(),
      applyEdits: (edits, selection) => apiMethods.current!.applyEdits(edits, selection),
      undo: () => apiMethods.current!.undo(),
      redo: () => apiMethods.current!.redo(),
    };
  }

  useLayoutEffect(() => {
    const input = textareaRef.current;
    return input ? registerSourceEditorApi(input, api.current!) : undefined;
  }, [tabId]);

  useLayoutEffect(() => {
    onApi?.(tabId, api.current);
    return () => onApi?.(tabId, null);
  }, [tabId, onApi]);

  useLayoutEffect(() => {
    onRegister?.(tabId, textareaRef.current);
    return () => onRegister?.(tabId, null);
  }, [tabId, onRegister]);

  useLayoutEffect(
    () =>
      registerImageReachability(tabId, () => {
        const urls = new Set(getImageUrls(pushed.current));
        for (const snapshot of [...history.current, ...future.current]) {
          let cached = snapshotImageUrls.current.get(snapshot);
          if (!cached) {
            cached = getImageUrls(snapshot.text);
            snapshotImageUrls.current.set(snapshot, cached);
          }
          for (const url of cached) urls.add(url);
        }
        return urls;
      }),
    [tabId],
  );
  useLayoutEffect(() => imageReferencesChanged(tabId), [tabId, draft, value, imageRewrites]);

  useLayoutEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [tabId, value, active]);

  // 外部修改(切换标签、Milkdown 同步、磁盘重载)才回灌到本地草稿
  useLayoutEffect(() => {
    const references = imageRewrites !== lastRewrites.current ? imageRewrites : undefined;
    lastRewrites.current = imageRewrites;
    if (references) {
      const identities = imageIdentityReferences(tabId);
      const stableTokens = new Set(getPendingImages(tabId).map((image) => image.placeholder));
      const historyReferences = references.filter(
        (reference) => !stableTokens.has(reference.placeholder),
      );
      const rebase = (snapshot: Snapshot): Snapshot =>
        rewriteSnapshot(rewriteSnapshot(snapshot, historyReferences), identities);
      history.current = history.current.map(rebase);
      future.current = future.current.map(rebase);
    }
    if (value === pushed.current) return;
    const before = pushed.current;
    const input = textareaRef.current;
    const selection = input
      ? { start: input.selectionStart, end: input.selectionEnd }
      : selectionRef.current;
    if (input) {
      scroll.current = { top: input.scrollTop, left: input.scrollLeft };
      direction.current = input.selectionDirection ?? 'none';
    }
    const map = (offset: number) =>
      references
        ? mapImageOffset(before, references, offset)
        : mapTextOffset(before, value, offset);
    if (input && active) scroll.current.top = mapSourceScroll(input, before, value, map);
    pendingSelection.current = {
      start: map(selection.start),
      end: map(selection.end),
    };
    pushed.current = value;
    publishSourceEditorChange(api.current!, before, value, undefined, map);
    setDraft(value);
    if (!references) {
      history.current = [];
      future.current = [];
    }
    lastPushAt.current = 0;
    lastInputType.current = '';
    restoreScroll.current = true;
  }, [tabId, value, imageRewrites, active]);

  useLayoutEffect(() => {
    if (!active) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(selectionRef.current.start, selectionRef.current.end, direction.current);
    el.scrollTop = scroll.current.top;
    el.scrollLeft = scroll.current.left;
  }, [active]);

  // 撤销后把光标放回快照位置
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const target = pendingSelection.current;
    if (!el || !target) return;
    pendingSelection.current = null;
    el.setSelectionRange(target.start, target.end, direction.current);
    selectionRef.current = target;
    if (restoreScroll.current) {
      el.scrollTop = scroll.current.top;
      el.scrollLeft = scroll.current.left;
      restoreScroll.current = false;
    }
  }, [draft]);

  const currentSnapshot = (): Snapshot => {
    const selection = pendingSelection.current ?? selectionRef.current;
    return rewriteSnapshot({ text: pushed.current, ...selection }, imageIdentityReferences(tabId));
  };
  const visibleSnapshot = (snapshot: Snapshot): Snapshot =>
    rewriteSnapshot(snapshot, imageSourceReferences(tabId));

  const pushHistory = () => {
    const now = Date.now();
    const coalesce =
      history.current.length > 0 &&
      lastPushAt.current !== 0 &&
      now - lastPushAt.current < COALESCE_MS;
    lastPushAt.current = now;
    if (coalesce) return;
    history.current.push(currentSnapshot());
    if (history.current.length > HISTORY_LIMIT) history.current.shift();
  };

  const applySnapshot = (snapshot: Snapshot) => {
    const visible = visibleSnapshot(snapshot);
    const before = pushed.current;
    generation.current += 1;
    pushed.current = visible.text;
    pendingSelection.current = { start: visible.start, end: visible.end };
    publishSourceEditorChange(api.current!, before, visible.text);
    setDraft(visible.text);
    onChange(tabId, visible.text);
    imageReferencesChanged(tabId);
  };

  const handleUndo = () => {
    let snapshot = history.current.pop();
    // 取消组字可能留下同文本快照,不能让下一次撤销变成无动作。
    while (snapshot && visibleSnapshot(snapshot).text === pushed.current)
      snapshot = history.current.pop();
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

  const handleChange = (next: string, inputType = '', edits?: readonly SourceTextEdit[]) => {
    if (next === pushed.current) return;
    if (!composing.current) {
      if (
        inputType !== lastInputType.current ||
        !['insertText', 'deleteContentBackward', 'deleteContentForward'].includes(inputType)
      ) {
        lastPushAt.current = 0;
      }
      pushHistory();
    }
    lastInputType.current = inputType;
    future.current = [];
    const before = pushed.current;
    pushed.current = next;
    publishSourceEditorChange(
      api.current!,
      before,
      next,
      edits,
      edits ? (offset) => mapSourceEditOffset(offset, edits) : undefined,
    );
    generation.current += 1;
    setDraft(next);
    onChange(tabId, next);
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
    direction.current = el.selectionDirection ?? 'none';
    if (
      selectionRef.current.start !== el.selectionStart ||
      selectionRef.current.end !== el.selectionEnd
    ) {
      lastPushAt.current = 0;
      selectionRef.current = { start: el.selectionStart, end: el.selectionEnd };
    }
  };

  apiMethods.current = {
    read: () => {
      const input = textareaRef.current;
      const selection =
        input?.value === pushed.current
          ? { start: input.selectionStart, end: input.selectionEnd }
          : (pendingSelection.current ?? selectionRef.current);
      return { text: pushed.current, ...selection };
    },
    applyEdits: (edits: readonly SourceTextEdit[], selection?: SourceSelection) => {
      const input = textareaRef.current;
      if (!input?.isConnected || composing.current || !edits.length) return false;
      const before = pushed.current;
      const prepared = prepareSourceEdits(before, edits);
      if (!prepared || prepared.text === before) return false;
      const current = apiMethods.current!.read();
      const target = selection ?? {
        start: mapSourceEditOffset(current.start, prepared.edits),
        end: mapSourceEditOffset(current.end, prepared.edits),
      };
      if (
        !Number.isInteger(target.start) ||
        !Number.isInteger(target.end) ||
        target.start < 0 ||
        target.end < target.start ||
        target.end > prepared.text.length
      )
        return false;
      if (input.value === before) rememberSelection();
      lastPushAt.current = 0;
      lastInputType.current = '';
      handleChange(prepared.text, 'insertReplacementText', prepared.edits);
      pendingSelection.current = target;
      selectionRef.current = target;
      direction.current = 'none';
      lastPushAt.current = 0;
      lastInputType.current = '';
      imageReferencesChanged(tabId);
      return true;
    },
    undo: () => {
      if (!textareaRef.current?.isConnected || composing.current) return;
      if (textareaRef.current?.value === pushed.current) rememberSelection();
      handleUndo();
    },
    redo: () => {
      if (!textareaRef.current?.isConnected || composing.current) return;
      if (textareaRef.current?.value === pushed.current) rememberSelection();
      handleRedo();
    },
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onImagePaste) return;
    const current = generation.current;
    rememberSelection();
    let pasted = '';
    void pasteSourceImage(
      event,
      event.currentTarget,
      async (file) => (pasted = await onImagePaste(tabId, file)),
      (text, caret) => {
        handleChange(text, 'insertFromPaste');
        pendingSelection.current = { start: caret, end: caret };
      },
      () => generation.current === current,
    ).finally(() => {
      if (pasted) settleImageInsertion(tabId, pasted);
    });
  };

  return (
    <div className="source-editor" hidden={!active} aria-label="Markdown 源码编辑">
      <div className="source-editor-head">
        <div className="source-editor-title">
          <IconCode size={15} /> <span>源码模式</span>
        </div>
        <button
          className="source-editor-close"
          onClick={onClose}
          title="返回编辑模式"
          aria-label="返回编辑模式"
        >
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
        onBlur={rememberSelection}
        onScroll={(event) => {
          if (active)
            scroll.current = {
              top: event.currentTarget.scrollTop,
              left: event.currentTarget.scrollLeft,
            };
        }}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        onPaste={handlePaste}
        spellCheck={false}
        aria-label="Markdown 源码"
      />
    </div>
  );
});
