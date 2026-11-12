import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { useEditor, Milkdown, MilkdownProvider } from '@milkdown/react';
import type { Editor } from '@milkdown/kit/core';
import { createEditor, getCurrentState, getEditorImageReferences } from '../lib/editor';
import {
  resolveImageSource,
  subscribeImageSources,
  resolveImageIdentity,
  resolveImageReference,
  registerImageReachability,
  imageReferencesChanged,
  settleImageInsertion,
} from '../lib/imageOps';
import type { EditorUpdate } from '../lib/types';
import type { MediaPreview } from '../lib/media';

interface EditorTabProps {
  tabId: string;
  initialContent: string;
  active: boolean;
  sourceMode: boolean;
  onUpdate: (id: string, update: EditorUpdate, isInitial?: boolean, coalesced?: boolean) => void;
  onActivity: (id: string, update: Pick<EditorUpdate, 'canUndo' | 'canRedo'>) => void;
  onRegister: (id: string, editor: Editor | null) => void;
  onImagePaste?: (tabId: string, file: File) => Promise<string>;
  onMediaPreview?: (media: MediaPreview) => void;
  onDocumentLink?: (tabId: string, href: string) => void;
}

/**
 * 每个标签页一个独立的 MilkdownProvider:
 * Milkdown 的 React 集成中,Provider 持有单一 editorFactory,
 * 多编辑器共享一个 Provider 会互相覆盖导致内容丢失。
 */
export const EditorTab = memo(function EditorTab(props: EditorTabProps) {
  const activated = useRef(props.active);
  if (props.active) activated.current = true;
  // Session restore mounts only the visible editor; visited tabs stay alive afterwards.
  if (!activated.current) return null;
  return (
    <MilkdownProvider>
      <EditorTabInner {...props} />
    </MilkdownProvider>
  );
});

function EditorTabInner({
  tabId,
  initialContent,
  active,
  sourceMode,
  onUpdate,
  onActivity,
  onRegister,
  onImagePaste,
  onMediaPreview,
  onDocumentLink,
}: EditorTabProps) {
  const previewRef = useRef(onMediaPreview);
  previewRef.current = onMediaPreview;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const onRegisterRef = useRef(onRegister);
  onRegisterRef.current = onRegister;
  const onImagePasteRef = useRef(onImagePaste);
  onImagePasteRef.current = onImagePaste;
  const linkRef = useRef(onDocumentLink);
  linkRef.current = onDocumentLink;
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;
  const initialContentRef = useRef(initialContent);
  const initializedRef = useRef(false);
  const activity = useRef(0);
  useLayoutEffect(() => {
    activity.current += 1;
    return () => {
      activity.current += 1;
    };
  }, [active, sourceMode, tabId]);

  const { get, loading } = useEditor(
    (root) =>
      createEditor(root, initialContentRef.current, {
        onUpdate: (u, coalesced) => onUpdateRef.current(tabIdRef.current, u, false, coalesced),
        onActivity: (u) => onActivityRef.current(tabIdRef.current, u),
        deferUpdates: true,
        resolveImageSource: (url) => resolveImageSource(tabIdRef.current, url),
        subscribeImageSources: (listener) => subscribeImageSources(tabIdRef.current, listener),
        resolveImageIdentity: (url) => resolveImageIdentity(tabIdRef.current, url),
        resolveImageReference: (token) => resolveImageReference(tabIdRef.current, token),
        onImageReferencesChanged: () => imageReferencesChanged(tabIdRef.current),
        onImagePasteSettled: (token) => settleImageInsertion(tabIdRef.current, token),
        onMediaPreview: (media) => previewRef.current?.(media),
        onDocumentLink: (href) => linkRef.current?.(tabIdRef.current, href),
        captureImagePaste: () => {
          const current = activity.current;
          return () => activity.current === current;
        },
        onImagePaste: (file) =>
          onImagePasteRef.current?.(tabIdRef.current, file) ??
          Promise.reject(new Error('图片处理不可用')),
      }),
    [],
  );
  const editor = loading ? null : (get() ?? null);

  useEffect(() => {
    onRegisterRef.current(tabId, editor);
    return () => onRegisterRef.current(tabId, null);
  }, [editor, tabId]);

  useEffect(() => {
    if (!editor) return;
    return registerImageReachability(tabId, () => getEditorImageReferences(editor));
  }, [editor, tabId]);

  // 编辑器就绪后,推送一次初始状态(大纲、统计、markdown 镜像)
  useEffect(() => {
    if (!editor || initializedRef.current) return;
    initializedRef.current = true;
    onUpdateRef.current(tabId, getCurrentState(editor, initialContentRef.current), true);
  }, [editor, tabId]);

  return (
    <div
      className={`editor-tab${active ? ' active' : ''}`}
      data-active={active ? '1' : '0'}
      {...{ inert: !active || sourceMode ? '' : undefined }}
      aria-hidden={!active || sourceMode ? true : undefined}
    >
      <div className="milkdown-container">
        <Milkdown />
      </div>
    </div>
  );
}
