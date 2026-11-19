import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { useEditor, Milkdown, MilkdownProvider } from '@milkdown/react';
import { editorViewCtx, type Editor } from '@milkdown/kit/core';
import { createEditor, getCurrentState, getEditorImageReferences } from '../lib/editor';
import {
  imagePreviewUrl,
  subscribeImageSources,
  imageTokenForUrl,
  imageUrlForToken,
  registerImageReachability,
  imageReferencesChanged,
  settleImageInsertion,
} from '../lib/imageOps';
import type { EditorUpdate } from '../lib/types';
import type { MediaPreview } from '../lib/media';

interface EditorTabProps {
  tabId: string;
  initialContent: string;
  isNew: boolean;
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

function EditorTabInner(props: EditorTabProps) {
  const { tabId, active, sourceMode } = props;
  // The editor is created once; its callbacks read the newest props through this ref.
  const latest = useRef(props);
  latest.current = props;
  const initialContentRef = useRef(props.initialContent);
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
        onUpdate: (u, coalesced) =>
          latest.current.onUpdate(latest.current.tabId, u, false, coalesced),
        onActivity: (u) => latest.current.onActivity(latest.current.tabId, u),
        deferUpdates: true,
        imagePreviewUrl: (url) => imagePreviewUrl(latest.current.tabId, url),
        subscribeImageSources: (listener) => subscribeImageSources(latest.current.tabId, listener),
        imageTokenForUrl: (url) => imageTokenForUrl(latest.current.tabId, url),
        imageUrlForToken: (token) => imageUrlForToken(latest.current.tabId, token),
        onImageReferencesChanged: () => imageReferencesChanged(latest.current.tabId),
        onImagePasteSettled: (token) => settleImageInsertion(latest.current.tabId, token),
        onMediaPreview: (media) => latest.current.onMediaPreview?.(media),
        onDocumentLink: (href) => latest.current.onDocumentLink?.(latest.current.tabId, href),
        captureImagePaste: () => {
          const current = activity.current;
          return () => activity.current === current;
        },
        onImagePaste: (file) =>
          latest.current.onImagePaste?.(latest.current.tabId, file) ??
          Promise.reject(new Error('图片处理不可用')),
      }),
    [],
  );
  const editor = loading ? null : (get() ?? null);

  useEffect(() => {
    latest.current.onRegister(tabId, editor);
    return () => latest.current.onRegister(tabId, null);
  }, [editor, tabId]);

  useEffect(() => {
    if (!editor) return;
    return registerImageReachability(tabId, () => getEditorImageReferences(editor));
  }, [editor, tabId]);

  // 编辑器就绪后,推送一次初始状态(大纲、统计、markdown 镜像)
  useEffect(() => {
    if (!editor || initializedRef.current) return;
    initializedRef.current = true;
    latest.current.onUpdate(tabId, getCurrentState(editor, initialContentRef.current), true);
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    view.dom.setAttribute('aria-label', '文档正文');
    if (
      latest.current.isNew &&
      latest.current.active &&
      !latest.current.sourceMode &&
      !document.activeElement?.closest('input, textarea, select, [role="dialog"], .recent-menu')
    )
      view.focus();
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
