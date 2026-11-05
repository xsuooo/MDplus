import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/prose/state';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TAB_RENDER_MS } from '../config/constants';
import { showMessage } from '../lib/dialog';
import { redo, undo } from '../lib/editor';
import {
  BODY_FONTS,
  CODE_FONTS,
  readBodyFont,
  readCodeFont,
  writeBodyFont,
  writeCodeFont,
  type BodyFont,
  type CodeFont,
} from '../lib/editorFont';
import {
  renderedPlace,
  restoreRendered,
  restoreSource,
  sourcePlace,
  toRendered,
  toSource,
  type RenderedPlace,
  type SourcePlace,
} from '../lib/editorPosition';
import {
  bindEditorZoomControls,
  nextEditorZoom,
  readEditorZoom,
  writeEditorZoom,
} from '../lib/editorZoom';
import { errorMessage } from '../lib/errors';
import { saveImage } from '../lib/imageOps';
import { refreshMermaidTheme } from '../lib/mermaid';
import { protectPastedImage } from '../lib/recovery';
import { computeStats } from '../lib/stats';
import type { EditorUpdate } from '../lib/types';

import type { DocumentSession } from './useDocumentSession';
import type { RecoveryController } from './useRecovery';

export function useEditorView(
  session: DocumentSession,
  recovery: RecoveryController,
  scheduleAutoSave: (id: string) => void,
  changeSourcePreference: (source: boolean) => void,
) {
  const {
    setTabs,
    activeId,
    sourceMode,
    setSourceMode,
    setSearchOpen,
    editorRegistry,
    tabMirror,
    tabsRef,
    contentGenerations,
    tabRenderTimers,
    currentView,
    sourceRegistry,
    positions,
    enteringSource,
    syncEditor,
    rememberActive,
    resolveContent,
  } = session;
  const { prepareCurrentImages, protectDraft, cleanRecovery } = recovery;
  const [editorZoom, setEditorZoom] = useState(readEditorZoom);
  const [codeFont, setCodeFont] = useState(readCodeFont);
  const [bodyFont, setBodyFont] = useState(readBodyFont);
  useEffect(() => {
    void refreshMermaidTheme();
  }, [bodyFont]);
  const editorAreaRef = useRef<HTMLElement | null>(null);
  const fontPosition = useRef<{
    id: string;
    source?: SourcePlace;
    rendered?: RenderedPlace;
  } | null>(null);
  const captureFontPosition = useCallback(() => {
    rememberActive();
    const { activeId: id, sourceMode: source } = currentView.current;
    if (id) {
      const saved = positions.current[id];
      fontPosition.current = {
        id,
        source: source ? saved?.source : undefined,
        rendered: source ? undefined : saved?.rendered,
      };
    }
  }, [currentView, positions, rememberActive]);
  const changeBodyFont = useCallback(
    (font: BodyFont) => {
      if (font === bodyFont) return;
      captureFontPosition();
      setBodyFont(font);
    },
    [bodyFont, captureFontPosition],
  );
  const changeCodeFont = useCallback(
    (font: CodeFont) => {
      if (font === codeFont) return;
      captureFontPosition();
      setCodeFont(font);
    },
    [codeFont, captureFontPosition],
  );

  useLayoutEffect(() => {
    const body = BODY_FONTS.find((font) => font.id === bodyFont)!;
    const code = CODE_FONTS.find((font) => font.id === codeFont)!;
    // Dialogs, drag overlays and the error fallback share these document-wide roles.
    const style = document.documentElement.style;
    style.setProperty('--font-body', `${body.family}, var(--font-sans)`);
    style.setProperty('--body-strong-weight', String(body.strongWeight));
    style.setProperty('--font-code', `${code.family}, var(--font-mono)`);
  }, [bodyFont, codeFont]);

  useLayoutEffect(() => {
    const saved = fontPosition.current;
    fontPosition.current = null;
    if (!saved || saved.id !== activeId) return;
    const restore = () => {
      const input = sourceRegistry.current[saved.id];
      const editor = editorRegistry.current[saved.id];
      if (input && saved.source) restoreSource(input, saved.source);
      if (editor && saved.rendered) restoreRendered(editor, saved.rendered);
    };
    restore();
    let cancelled = false;
    const cancel = (event: Event) => {
      const target = event.target;
      // Radio selection emits input after React installs this effect; it is not a document edit.
      if (
        event.type === 'input' &&
        target instanceof HTMLInputElement &&
        target.type === 'radio' &&
        target.name === 'code-font'
      )
        return;
      cancelled = true;
    };
    for (const event of ['wheel', 'keydown', 'pointerdown', 'input'])
      window.addEventListener(event, cancel, true);
    const body = BODY_FONTS.find((font) => font.id === bodyFont)!;
    const families = [
      body.family,
      ...CODE_FONTS.find((font) => font.id === codeFont)!.family.split(', '),
    ];
    void Promise.allSettled([
      ...families.map((family) => document.fonts.load(`400 16px ${family}`, '中文 Mixed')),
      document.fonts.load(`${body.strongWeight} 16px ${body.family}`, '中文 Bold'),
    ]).then(() => {
      if (!cancelled) restore();
    });
    return () => {
      cancelled = true;
      for (const event of ['wheel', 'keydown', 'pointerdown', 'input'])
        window.removeEventListener(event, cancel, true);
    };
  }, [bodyFont, codeFont, activeId, sourceMode, sourceRegistry, editorRegistry]);

  useLayoutEffect(() => {
    if (!activeId) return;
    const input = sourceRegistry.current[activeId];
    const editor = editorRegistry.current[activeId];
    const saved = (positions.current[activeId] ??= {});
    const markdown =
      tabMirror.current[activeId]?.markdown ??
      tabsRef.current.find((tab) => tab.id === activeId)?.markdown ??
      '';
    if (sourceMode && input) {
      if (enteringSource.current && editor) {
        // The source component first applies any newer rendered draft in its layout effect.
        queueMicrotask(() => {
          if (
            currentView.current.activeId !== activeId ||
            !currentView.current.sourceMode ||
            !input.isConnected
          )
            return;
          toSource(editor, markdown, input, saved.exchange);
          saved.exchange = {
            markdown,
            source: sourcePlace(input),
            rendered: renderedPlace(editor),
          };
          saved.source = sourcePlace(input);
        });
      } else if (saved.source) restoreSource(input, saved.source);
    } else if (editor) {
      syncEditor(activeId, markdown);
      // React has now removed inert, so a source-mode return can restore visible focus.
      if (saved.rendered) restoreRendered(editor, saved.rendered, saved.sourceMode === true);
    }
    saved.sourceMode = sourceMode;
    enteringSource.current = false;
  }, [
    activeId,
    currentView,
    editorRegistry,
    enteringSource,
    positions,
    sourceMode,
    sourceRegistry,
    syncEditor,
    tabMirror,
    tabsRef,
  ]);
  useEffect(() => {
    const area = editorAreaRef.current;
    if (!area) return;
    return bindEditorZoomControls(area, (action) =>
      setEditorZoom((value) => nextEditorZoom(value, action)),
    );
  }, []);

  useEffect(() => {
    writeEditorZoom(editorZoom);
  }, [editorZoom]);

  useEffect(() => {
    writeCodeFont(codeFont);
  }, [codeFont]);
  useEffect(() => {
    writeBodyFont(bodyFont);
  }, [bodyFont]);

  /* ---------- 编辑器更新回传 ---------- */
  // 输入节流:tabsRef 始终即时更新(保存/关闭等正确性路径读取它),
  // 仅节流 React setTabs(视觉渲染),避免每次敲键都重渲染整个 App。
  const scheduleTabRender = useCallback(
    (id: string) => {
      const existing = tabRenderTimers.current[id];
      if (existing) clearTimeout(existing);
      tabRenderTimers.current[id] = setTimeout(() => {
        delete tabRenderTimers.current[id];
        setTabs([...tabsRef.current]);
      }, TAB_RENDER_MS);
    },
    [setTabs, tabRenderTimers, tabsRef],
  );

  const handleTabUpdate = useCallback(
    (id: string, update: EditorUpdate, isInitial = false) => {
      if (isInitial && (contentGenerations.current[id] ?? 0) > 0) {
        const latest = tabMirror.current[id]?.markdown;
        if (latest !== undefined) syncEditor(id, latest);
        scheduleTabRender(id);
        return;
      }
      const prev = tabsRef.current.find((t) => t.id === id);
      // 初始化只更新派生状态，不能用序列化结果改写尚未编辑的原文。
      const markdown = isInitial
        ? (tabMirror.current[id]?.markdown ?? prev?.markdown ?? update.markdown)
        : update.markdown;
      const currentUpdate = isInitial
        ? { ...update, markdown, stats: computeStats(markdown) }
        : update;
      tabMirror.current[id] = currentUpdate;
      if (isInitial) {
        contentGenerations.current[id] ??= 0;
      } else {
        contentGenerations.current[id] = (contentGenerations.current[id] ?? 0) + 1;
      }
      // 以「最近一次保存成功的内容」为基线判定 dirty,避免编辑又回到打开时内容后误判为已保存
      const dirty = isInitial
        ? (prev?.dirty ?? false)
        : prev
          ? markdown !== prev.savedContent
          : true;
      tabsRef.current = tabsRef.current.map((t) =>
        t.id === id ? { ...t, markdown, stats: currentUpdate.stats, dirty } : t,
      );
      if (isInitial) {
        const tab = tabsRef.current.find((tab) => tab.id === id);
        if (tab && (tab.dirty || (tab.isNew && !!tab.markdown.trim()))) protectDraft(tab);
        setTabs([...tabsRef.current]);
        return;
      }
      void prepareCurrentImages(id, true).catch((error) => console.warn('图片引用准备失败', error));
      if (dirty) scheduleAutoSave(id);
      const changed = tabsRef.current.find((tab) => tab.id === id);
      if (changed && (dirty || changed.isNew)) protectDraft(changed);
      else if (changed) void cleanRecovery(id);
      scheduleTabRender(id);
    },
    [
      contentGenerations,
      tabsRef,
      tabMirror,
      prepareCurrentImages,
      scheduleAutoSave,
      protectDraft,
      cleanRecovery,
      scheduleTabRender,
      syncEditor,
      setTabs,
    ],
  );

  const registerEditor = useCallback(
    (id: string, editor: Editor | null) => {
      editorRegistry.current[id] = editor;
    },
    [editorRegistry],
  );

  /* ---------- 图片粘贴处理 ---------- */
  const handleImagePaste = useCallback(
    async (tabId: string, file: File): Promise<string> => {
      try {
        const imagePath = await saveImage(file, tabId);
        await protectPastedImage(tabId, imagePath);
        if (!tabsRef.current.some((tab) => tab.id === tabId)) return '';
        return imagePath;
      } catch (err) {
        console.error('保存图片失败', err);
        await showMessage(`保存图片失败: ${errorMessage(err)}`, 'error');
        throw err;
      }
    },
    [tabsRef],
  );

  /* ---------- 撤销 / 重做 ---------- */
  const handleUndo = useCallback(() => {
    const editor = activeId ? editorRegistry.current[activeId] : null;
    if (editor) undo(editor);
  }, [activeId, editorRegistry]);

  const handleRedo = useCallback(() => {
    const editor = activeId ? editorRegistry.current[activeId] : null;
    if (editor) redo(editor);
  }, [activeId, editorRegistry]);

  /* ---------- 源码模式 ---------- */
  const toggleSourceMode = useCallback(() => {
    const { activeId: id, sourceMode: wasSource } = currentView.current;
    rememberActive();
    if (id && wasSource) {
      const tab = tabsRef.current.find((tab) => tab.id === id);
      const input = sourceRegistry.current[id];
      const editor = editorRegistry.current[id];
      const markdown = tabMirror.current[id]?.markdown ?? tab?.markdown ?? '';
      syncEditor(id, markdown);
      if (input && editor) {
        const saved = (positions.current[id] ??= {});
        toRendered(editor, markdown, input, saved.exchange);
        saved.rendered = renderedPlace(editor);
        saved.exchange = { markdown, source: sourcePlace(input), rendered: saved.rendered };
      }
      // The rendered editor can serialize this draft differently during sync.
      // Rebuild the preparation/recovery barrier against the preserved source.
      const current = tabsRef.current.find((candidate) => candidate.id === id);
      if (current && (current.dirty || (current.isNew && !!resolveContent(current).trim())))
        protectDraft(current);
    } else {
      enteringSource.current = true;
      setSearchOpen(false);
    }
    setSourceMode(!wasSource);
    changeSourcePreference(!wasSource);
  }, [
    currentView,
    rememberActive,
    setSourceMode,
    changeSourcePreference,
    tabsRef,
    sourceRegistry,
    editorRegistry,
    tabMirror,
    syncEditor,
    resolveContent,
    protectDraft,
    positions,
    enteringSource,
    setSearchOpen,
  ]);

  const handleSourceChange = useCallback(
    (id: string, text: string) => {
      const activeId = id;
      if (activeId) {
        contentGenerations.current[activeId] = (contentGenerations.current[activeId] ?? 0) + 1;
        const prev = tabsRef.current.find((t) => t.id === activeId);
        const dirty = prev ? text !== prev.savedContent : true;
        const stats = computeStats(text);
        tabMirror.current[activeId] = {
          ...(tabMirror.current[activeId] ?? {
            markdown: text,
            outline: [],
            stats: { chars: 0, words: 0, lines: 1 },
            canUndo: false,
            canRedo: false,
          }),
          markdown: text,
          stats,
        };
        tabsRef.current = tabsRef.current.map((t) =>
          t.id === activeId ? { ...t, markdown: text, stats, dirty } : t,
        );
        void prepareCurrentImages(activeId, true).catch((error) =>
          console.warn('图片引用准备失败', error),
        );
        if (dirty) scheduleAutoSave(activeId);
        const changed = tabsRef.current.find((tab) => tab.id === activeId);
        if (changed && (dirty || changed.isNew)) protectDraft(changed);
        else if (changed) void cleanRecovery(activeId);
        setTabs([...tabsRef.current]);
      }
    },
    [
      contentGenerations,
      tabsRef,
      tabMirror,
      prepareCurrentImages,
      scheduleAutoSave,
      protectDraft,
      cleanRecovery,
      setTabs,
    ],
  );

  /* ---------- 大纲跳转 ---------- */
  const jumpToOutline = useCallback(
    (pos: number) => {
      const editor = activeId ? editorRegistry.current[activeId] : null;
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const target = pos + 1;
        if (target < 0 || target > view.state.doc.content.size) return;
        view.dispatch(
          view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(target))),
        );
        view.focus();
        // Navigate once; normal editing and selection restoration remain instant.
        requestAnimationFrame(() => {
          const dom = view.nodeDOM(pos);
          const scroller = view.dom.closest<HTMLElement>('.milkdown-container');
          if (dom instanceof HTMLElement && scroller) {
            scroller.scrollTo({
              top:
                scroller.scrollTop +
                dom.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top -
                24,
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 'instant'
                : 'smooth',
            });
          }
        });
      });
    },
    [activeId, editorRegistry],
  );

  return {
    editorAreaRef,
    editorZoom,
    setEditorZoom,
    bodyFont,
    codeFont,
    changeBodyFont,
    changeCodeFont,
    handleTabUpdate,
    registerEditor,
    handleImagePaste,
    handleUndo,
    handleRedo,
    toggleSourceMode,
    handleSourceChange,
    jumpToOutline,
  };
}
