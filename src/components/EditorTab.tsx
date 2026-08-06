import { memo, useEffect, useRef } from 'react';
import { useEditor, Milkdown, MilkdownProvider } from '@milkdown/react';
import type { Editor } from '@milkdown/kit/core';
import { createEditor, getCurrentState } from '../lib/editor';
import type { Tab, EditorUpdate } from '../lib/types';

interface EditorTabProps {
  tab: Tab;
  active: boolean;
  onUpdate: (id: string, update: EditorUpdate, isInitial?: boolean) => void;
  onRegister: (id: string, editor: Editor | null) => void;
  onImagePaste?: (file: File) => Promise<string>;
}

/**
 * 每个标签页一个独立的 MilkdownProvider:
 * Milkdown 的 React 集成中,Provider 持有单一 editorFactory,
 * 多编辑器共享一个 Provider 会互相覆盖导致内容丢失。
 */
export const EditorTab = memo(function EditorTab(props: EditorTabProps) {
  return (
    <MilkdownProvider>
      <EditorTabInner {...props} />
    </MilkdownProvider>
  );
});

function EditorTabInner({ tab, active, onUpdate, onRegister, onImagePaste }: EditorTabProps) {
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onRegisterRef = useRef(onRegister);
  onRegisterRef.current = onRegister;
  const onImagePasteRef = useRef(onImagePaste);
  onImagePasteRef.current = onImagePaste;
  const tabIdRef = useRef(tab.id);
  tabIdRef.current = tab.id;
  const initialContentRef = useRef(tab.initialContent);
  const initializedRef = useRef(false);

  const { get, loading } = useEditor(
    (root) =>
      createEditor(root, initialContentRef.current, {
        onUpdate: (u) => onUpdateRef.current(tabIdRef.current, u),
        onImagePaste: onImagePasteRef.current,
      }),
    [],
  );

  useEffect(() => {
    onRegisterRef.current(tab.id, loading ? null : get() ?? null);
    return () => onRegisterRef.current(tab.id, null);
  }, [get, loading, tab.id]);

  // 编辑器就绪后,推送一次初始状态(大纲、统计、markdown 镜像)
  useEffect(() => {
    if (loading || initializedRef.current) return;
    const editor = get();
    if (!editor) return;
    initializedRef.current = true;
    onUpdateRef.current(tab.id, getCurrentState(editor), true);
  }, [loading, get, tab.id]);

  return (
    <div className={`editor-tab${active ? ' active' : ''}`} data-active={active ? '1' : '0'}>
      <div className="milkdown-container">
        <Milkdown />
      </div>
    </div>
  );
}
