import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/prose/state';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IMAGE_PREPARATION_MS, TAB_RENDER_MS } from '../config/constants';
import { showMessage } from '../lib/dialog';
import { needsDocumentProtection } from '../lib/documentProtection';
import { redo, undo } from '../lib/editor';
import { flushEditorUpdate } from '../lib/editorUpdates';
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
  extractSourceOutline,
  renderedPlace,
  restoreRendered,
  restoreSource,
  restoreSessionRendered,
  restoreSessionSource,
  sourcePlace,
  toRendered,
  toSource,
  type Ast,
  type RenderedPlace,
  type SourcePlace,
} from '../lib/editorPosition';
import { measureSourceText } from '../lib/sourcePosition';
import { readEditorWidth, writeEditorWidth, type EditorWidth } from '../lib/editorWidth';
import { errorMessage } from '../lib/errors';
import { saveImage, settleImageInsertion } from '../lib/imageOps';
import { refreshMermaidTheme } from '../lib/mermaid';
import { protectPastedImage } from '../lib/recovery';
import { computeStats } from '../lib/stats';
import type { EditorUpdate, OutlineItem } from '../lib/types';

import type { DocumentSession } from './useDocumentSession';
import type { RecoveryController } from './useRecovery';

export function useEditorView(
  session: DocumentSession,
  recovery: RecoveryController,
  scheduleAutoSave: (id: string) => void,
  changeSourcePreference: (source: boolean) => void,
  outlineOpen: boolean,
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
    saveGenerations,
    tabRenderTimers,
    currentView,
    sourceRegistry,
    positions,
    positionVersion,
    enteringSource,
    syncEditor,
    rememberActive,
    resolveContent,
  } = session;
  const { prepareCurrentImages, protectDraft, cleanRecovery } = recovery;
  const [codeFont, setCodeFont] = useState(readCodeFont);
  const [bodyFont, setBodyFont] = useState(readBodyFont);
  const [editorWidth, setEditorWidth] = useState(readEditorWidth);
  // Worker inputs follow committed state; discarded renders must not consume newer mirror content.
  const sourceMarkdown = session.activeTab?.markdown ?? '';
  const [sourceOutline, setSourceOutline] = useState<{
    id: string;
    markdown: string;
    items: OutlineItem[];
    error: boolean;
  } | null>(null);
  const sourceEditor = activeId ? editorRegistry.current[activeId] : null;
  useEffect(() => {
    if (!outlineOpen || !sourceMode || !activeId || !sourceEditor) return;
    let worker: Worker | undefined;
    const fail = (error: unknown) => {
      worker?.terminate();
      console.warn('源码目录读取失败', error);
      setSourceOutline({ id: activeId, markdown: sourceMarkdown, items: [], error: true });
    };
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL('../lib/sourceOutline.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (event: MessageEvent<Ast>) => {
          worker?.terminate();
          try {
            setSourceOutline({
              id: activeId,
              markdown: sourceMarkdown,
              items: extractSourceOutline(sourceEditor, sourceMarkdown, event.data),
              error: false,
            });
          } catch (error) {
            fail(error);
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          fail(event.message);
        };
        worker.postMessage(sourceMarkdown);
      } catch (error) {
        fail(error);
      }
    }, IMAGE_PREPARATION_MS);
    return () => {
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [outlineOpen, sourceMode, activeId, sourceMarkdown, sourceEditor]);
  const currentSourceOutline =
    sourceOutline?.id === activeId && sourceOutline.markdown === sourceMarkdown
      ? sourceOutline
      : null;
  const outlineItems = sourceMode
    ? (currentSourceOutline?.items ?? [])
    : activeId
      ? (tabMirror.current[activeId]?.outline ?? [])
      : [];
  const outlineStatus =
    sourceMode && outlineOpen && activeId
      ? currentSourceOutline
        ? currentSourceOutline.error
          ? ('error' as const)
          : undefined
        : ('loading' as const)
      : undefined;
  useEffect(() => {
    void refreshMermaidTheme();
  }, [bodyFont]);
  const editorAreaRef = useRef<HTMLElement | null>(null);
  const fontPosition = useRef<{
    id: string;
    source?: SourcePlace;
    rendered?: RenderedPlace;
  } | null>(null);
  const sessionRestoreCleanups = useRef<Record<string, () => void>>({});
  useEffect(
    () => () => {
      for (const cancel of Object.values(sessionRestoreCleanups.current)) cancel();
    },
    [],
  );
  const restoreSessionPosition = useCallback(
    (id: string) => {
      if (currentView.current.activeId !== id) return;
      const saved = positions.current[id];
      const pending = saved?.pendingSessionPlace;
      if (!pending) return;
      const input = sourceRegistry.current[id];
      const editor = editorRegistry.current[id];
      const markdown =
        tabMirror.current[id]?.markdown ??
        tabsRef.current.find((tab) => tab.id === id)?.markdown ??
        '';
      if (currentView.current.sourceMode) {
        if (!input || !input.isConnected || input.closest('[hidden]')) return;
        restoreSessionSource(input, pending);
        saved.source = sourcePlace(input);
      } else {
        if (!editor) return;
        restoreSessionRendered(editor, markdown, pending);
        saved.rendered = renderedPlace(editor);
      }
      saved.sourceMode = currentView.current.sourceMode;
      delete saved.pendingSessionPlace;
      sessionRestoreCleanups.current[id]?.();
      const source = currentView.current.sourceMode;
      const generation = contentGenerations.current[id] ?? 0;
      let cancelled = false;
      let frame: number | undefined;
      let remaining = 2;
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        if (frame !== undefined) cancelAnimationFrame(frame);
        for (const event of ['wheel', 'keydown', 'pointerdown', 'input'])
          window.removeEventListener(event, cancel, true);
        if (sessionRestoreCleanups.current[id] === cancel)
          delete sessionRestoreCleanups.current[id];
      };
      const settle = () => {
        if (
          !cancelled &&
          currentView.current.activeId === id &&
          currentView.current.sourceMode === source &&
          (contentGenerations.current[id] ?? 0) === generation
        ) {
          if (source && input?.isConnected) {
            restoreSessionSource(input, pending);
            saved.source = sourcePlace(input);
          } else if (editor && editorRegistry.current[id] === editor) {
            restoreSessionRendered(editor, markdown, pending);
            saved.rendered = renderedPlace(editor);
          }
        }
        if (--remaining === 0) cancel();
      };
      sessionRestoreCleanups.current[id] = cancel;
      for (const event of ['wheel', 'keydown', 'pointerdown', 'input'])
        window.addEventListener(event, cancel, true);
      // The first restore works even in a hidden WebView; these bounded repeats
      // account for the first visible layout and bundled-font metrics settling.
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(settle);
      else queueMicrotask(settle);
      void Promise.resolve(document.fonts?.ready).then(settle, () => {
        if (--remaining === 0) cancel();
      });
    },
    [
      contentGenerations,
      currentView,
      editorRegistry,
      positions,
      sourceRegistry,
      tabMirror,
      tabsRef,
    ],
  );
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
  const changeEditorWidth = useCallback(
    (width: EditorWidth) => {
      if (width === editorWidth) return;
      captureFontPosition();
      setEditorWidth(width);
    },
    [editorWidth, captureFontPosition],
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
  }, [bodyFont, codeFont, editorWidth, activeId, sourceMode, sourceRegistry, editorRegistry]);

  useLayoutEffect(() => {
    if (!activeId) return;
    const input = sourceRegistry.current[activeId];
    const editor = editorRegistry.current[activeId];
    const saved = (positions.current[activeId] ??= {});
    const markdown =
      tabMirror.current[activeId]?.markdown ??
      tabsRef.current.find((tab) => tab.id === activeId)?.markdown ??
      '';
    if (saved.pendingSessionPlace) {
      restoreSessionPosition(activeId);
      // Registration of an asynchronous rich editor completes this restoration later.
      if (saved.pendingSessionPlace) return;
    }
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
      // Rich tabs retain their editor and receive edits, reloads and image saves
      // through their own update paths. Only a source-mode return needs sync.
      if (
        saved.sourceMode === true &&
        (saved.exchange?.markdown !== markdown ||
          saved.exchange.rendered.doc !== renderedPlace(editor).doc)
      )
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
    positionVersion,
    restoreSessionPosition,
    sourceMode,
    sourceRegistry,
    syncEditor,
    tabMirror,
    tabsRef,
  ]);
  useEffect(() => {
    writeCodeFont(codeFont);
  }, [codeFont]);
  useEffect(() => {
    writeBodyFont(bodyFont);
  }, [bodyFont]);
  useEffect(() => {
    writeEditorWidth(editorWidth);
  }, [editorWidth]);

  /* ---------- 编辑器更新回传 ---------- */
  // dirty 和 generation 即时更新，Markdown、统计和大纲按 120ms 合并。
  // 保存、关闭、导出和模式切换先 flushEditorUpdate，避免读取旧快照。
  const statsDirty = useRef(new Set<string>());
  const scheduleTabRender = useCallback(
    (id: string, refreshStats = false) => {
      if (refreshStats) statsDirty.current.add(id);
      const existing = tabRenderTimers.current[id];
      if (existing) return;
      tabRenderTimers.current[id] = setTimeout(() => {
        delete tabRenderTimers.current[id];
        if (statsDirty.current.delete(id)) {
          const tab = tabsRef.current.find((candidate) => candidate.id === id);
          if (tab) {
            const stats = computeStats(tab.markdown);
            tabsRef.current = tabsRef.current.map((candidate) =>
              candidate.id === id ? { ...candidate, stats } : candidate,
            );
            const mirror = tabMirror.current[id];
            if (mirror) tabMirror.current[id] = { ...mirror, stats };
          }
        }
        setTabs([...tabsRef.current]);
      }, TAB_RENDER_MS);
    },
    [setTabs, tabMirror, tabRenderTimers, tabsRef],
  );

  const handleEditorActivity = useCallback(
    (id: string, activity: Pick<EditorUpdate, 'canUndo' | 'canRedo'>) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === id);
      if (!tab) return;
      contentGenerations.current[id] = (contentGenerations.current[id] ?? 0) + 1;
      const mirror = tabMirror.current[id];
      if (mirror) tabMirror.current[id] = { ...mirror, ...activity };
      tabsRef.current = tabsRef.current.map((candidate) =>
        candidate.id === id ? { ...candidate, dirty: true } : candidate,
      );
      scheduleAutoSave(id);
      scheduleTabRender(id);
    },
    [contentGenerations, scheduleAutoSave, scheduleTabRender, tabMirror, tabsRef],
  );

  const handleTabUpdate = useCallback(
    (id: string, update: EditorUpdate, isInitial = false, coalesced = false) => {
      const prev = tabsRef.current.find((t) => t.id === id);
      const generation = contentGenerations.current[id] ?? 0;
      const latest = tabMirror.current[id]?.markdown;
      // Save As can rewrite image URLs before registration without a user edit.
      // Compare the mirror with the fixed creation source, not its serialization.
      if (
        isInitial &&
        (generation > 0 ||
          (prev !== undefined && latest !== undefined && latest !== prev.initialContent))
      ) {
        if (latest !== undefined) syncEditor(id, latest, generation > 0);
        scheduleTabRender(id);
        return;
      }
      // 初始化只更新派生状态，不能用序列化结果改写尚未编辑的原文。
      const markdown = isInitial ? (latest ?? prev?.markdown ?? update.markdown) : update.markdown;
      const currentUpdate = isInitial
        ? {
            ...update,
            markdown,
            stats: markdown === update.markdown ? update.stats : computeStats(markdown),
          }
        : update;
      tabMirror.current[id] = currentUpdate;
      if (isInitial) {
        contentGenerations.current[id] ??= 0;
      } else if (!coalesced) {
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
        if (tab && needsDocumentProtection(tab)) protectDraft(tab);
        setTabs([...tabsRef.current]);
        return;
      }
      void prepareCurrentImages(id, true).catch((error) => console.warn('图片引用准备失败', error));
      if (dirty && !coalesced) scheduleAutoSave(id);
      const changed = tabsRef.current.find((tab) => tab.id === id);
      if (changed && (dirty || changed.isNew || changed.preserveLocal)) protectDraft(changed);
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
      if (editor) restoreSessionPosition(id);
      else sessionRestoreCleanups.current[id]?.();
    },
    [editorRegistry, restoreSessionPosition],
  );

  /* ---------- 图片粘贴处理 ---------- */
  const handleImagePaste = useCallback(
    async (tabId: string, file: File): Promise<string> => {
      let imagePath: string | undefined;
      const lifetime = saveGenerations.current[tabId] ?? 0;
      const isCurrent = () =>
        (saveGenerations.current[tabId] ?? 0) === lifetime &&
        tabsRef.current.some((tab) => tab.id === tabId);
      try {
        imagePath = await saveImage(file, tabId);
        if (!isCurrent()) {
          settleImageInsertion(tabId, imagePath);
          return '';
        }
        await protectPastedImage(tabId, imagePath, isCurrent);
        if (!isCurrent()) {
          settleImageInsertion(tabId, imagePath);
          return '';
        }
        return imagePath;
      } catch (err) {
        if (imagePath) settleImageInsertion(tabId, imagePath);
        console.error('保存图片失败', err);
        await showMessage(`保存图片失败: ${errorMessage(err)}`, 'error');
        throw err;
      }
    },
    [saveGenerations, tabsRef],
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
    const pendingEditor = id ? editorRegistry.current[id] : null;
    if (pendingEditor) flushEditorUpdate(pendingEditor);
    rememberActive();
    if (id && wasSource) {
      const tab = tabsRef.current.find((tab) => tab.id === id);
      const input = sourceRegistry.current[id];
      const editor = editorRegistry.current[id];
      const markdown = tabMirror.current[id]?.markdown ?? tab?.markdown ?? '';
      const saved = (positions.current[id] ??= {});
      if (
        !editor ||
        saved.exchange?.markdown !== markdown ||
        saved.exchange.rendered.doc !== renderedPlace(editor).doc
      )
        syncEditor(id, markdown);
      if (input && editor) {
        toRendered(editor, markdown, input, saved.exchange);
        saved.rendered = renderedPlace(editor);
        saved.exchange = { markdown, source: sourcePlace(input), rendered: saved.rendered };
      }
      // The rendered editor can serialize this draft differently during sync.
      // Rebuild the preparation/recovery barrier against the preserved source.
      const current = tabsRef.current.find((candidate) => candidate.id === id);
      if (current && needsDocumentProtection(current, resolveContent(current)))
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
        tabMirror.current[activeId] = {
          ...(tabMirror.current[activeId] ?? {
            markdown: text,
            outline: [],
            stats: { chars: 0, words: 0, lines: 1 },
            canUndo: false,
            canRedo: false,
          }),
          markdown: text,
        };
        tabsRef.current = tabsRef.current.map((t) =>
          t.id === activeId ? { ...t, markdown: text, dirty } : t,
        );
        void prepareCurrentImages(activeId, true).catch((error) =>
          console.warn('图片引用准备失败', error),
        );
        if (dirty) scheduleAutoSave(activeId);
        const changed = tabsRef.current.find((tab) => tab.id === activeId);
        if (changed && (dirty || changed.isNew || changed.preserveLocal)) protectDraft(changed);
        else if (changed) void cleanRecovery(activeId);
        scheduleTabRender(activeId, true);
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
      scheduleTabRender,
    ],
  );

  /* ---------- 大纲跳转 ---------- */
  const jumpToOutline = useCallback(
    (pos: number) => {
      const { activeId: id, sourceMode: source } = currentView.current;
      if (source) {
        const input = id ? sourceRegistry.current[id] : null;
        if (!input?.isConnected || pos < 0 || pos > input.value.length) return;
        const top = measureSourceText(input, input.value, (at) => Math.max(0, at(pos) - 24));
        input.focus({ preventScroll: true });
        input.setSelectionRange(pos, pos);
        input.scrollTo({
          top,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth',
        });
        return;
      }
      const editor = id ? editorRegistry.current[id] : null;
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
          if (
            currentView.current.activeId !== id ||
            currentView.current.sourceMode ||
            editorRegistry.current[id!] !== editor
          )
            return;
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
    [currentView, sourceRegistry, editorRegistry],
  );

  return {
    editorAreaRef,
    bodyFont,
    codeFont,
    editorWidth,
    changeBodyFont,
    changeCodeFont,
    changeEditorWidth,
    handleTabUpdate,
    handleEditorActivity,
    registerEditor,
    handleImagePaste,
    handleUndo,
    handleRedo,
    toggleSourceMode,
    handleSourceChange,
    jumpToOutline,
    outlineItems,
    outlineStatus,
  };
}
