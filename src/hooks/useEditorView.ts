import type { Editor } from '@milkdown/kit/core';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { TAB_RENDER_MS } from '../config/constants';
import { showMessage } from '../lib/dialog';
import { needsDocumentProtection } from '../lib/documentProtection';
import { redo, undo } from '../lib/editor';
import { flushEditorUpdate } from '../lib/editorUpdates';
import {
  onUserInput,
  renderedPlace,
  restoreRendered,
  restoreSource,
  restoreSessionRendered,
  restoreSessionSource,
  sourcePlace,
  toRendered,
  toSource,
} from '../lib/position/editorPosition';
import { errorMessage } from '../lib/errors';
import { saveImage, settleImageInsertion } from '../lib/imageOps';
import { protectPastedImage } from '../lib/recovery';
import { computeStats } from '../lib/stats';
import type { EditorUpdate } from '../lib/types';

import type { Workspace } from './useWorkspace';
import type { RecoveryController } from './useRecovery';

/** Editor content flow: edits into the mirror, rich/source switching and cursor position restore. */
export function useEditorView(
  workspace: Workspace,
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
    tabRuntime,
    runtimeOf,
    tabsRef,
    tabEpoch,
    currentView,
    positionVersion,
    syncEditor,
    rememberActive,
    resolveContent,
  } = workspace;
  const tabRenderTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const enteringSource = useRef(false);
  const { prepareCurrentImages, saveRecoverySnapshot, deleteRecoverySnapshot } = recovery;
  const editorAreaRef = useRef<HTMLElement | null>(null);
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
      const saved = tabRuntime.current[id]?.position;
      const pending = saved?.pendingSessionPlace;
      if (!pending) return;
      const input = tabRuntime.current[id]?.sourceInput;
      const editor = tabRuntime.current[id]?.editor;
      const markdown =
        tabRuntime.current[id]?.mirror?.markdown ??
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
      const generation = tabRuntime.current[id]?.contentVersion ?? 0;
      let cancelled = false;
      let frame: number | undefined;
      let remaining = 2;
      let stopListening = () => {};
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        if (frame !== undefined) cancelAnimationFrame(frame);
        stopListening();
        if (sessionRestoreCleanups.current[id] === cancel)
          delete sessionRestoreCleanups.current[id];
      };
      const settle = () => {
        if (
          !cancelled &&
          currentView.current.activeId === id &&
          currentView.current.sourceMode === source &&
          (tabRuntime.current[id]?.contentVersion ?? 0) === generation
        ) {
          if (source && input?.isConnected) {
            restoreSessionSource(input, pending);
            saved.source = sourcePlace(input);
          } else if (editor && tabRuntime.current[id]?.editor === editor) {
            restoreSessionRendered(editor, markdown, pending);
            saved.rendered = renderedPlace(editor);
          }
        }
        if (--remaining === 0) cancel();
      };
      sessionRestoreCleanups.current[id] = cancel;
      stopListening = onUserInput(cancel);
      // The first restore works even in a hidden WebView; these bounded repeats
      // account for the first visible layout and bundled-font metrics settling.
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(settle);
      else queueMicrotask(settle);
      void Promise.resolve(document.fonts?.ready).then(settle, () => {
        if (--remaining === 0) cancel();
      });
    },
    [tabRuntime, currentView, tabsRef],
  );

  useLayoutEffect(() => {
    if (!activeId) return;
    const input = tabRuntime.current[activeId]?.sourceInput;
    const editor = tabRuntime.current[activeId]?.editor;
    const saved = (runtimeOf(activeId).position ??= {});
    const markdown =
      tabRuntime.current[activeId]?.mirror?.markdown ??
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
    tabRuntime,
    runtimeOf,
    positionVersion,
    restoreSessionPosition,
    sourceMode,
    syncEditor,
    tabsRef,
  ]);

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
            const mirror = tabRuntime.current[id]?.mirror;
            if (mirror) runtimeOf(id).mirror = { ...mirror, stats };
          }
        }
        setTabs([...tabsRef.current]);
      }, TAB_RENDER_MS);
    },
    [setTabs, tabRuntime, runtimeOf, tabsRef],
  );
  // 卸载后定时器不能再触发 setTabs。同时删除条目，StrictMode 重放清理后才能重新排入。
  useEffect(() => {
    const timers = tabRenderTimers.current;
    return () => {
      for (const id of Object.keys(timers)) {
        clearTimeout(timers[id]);
        delete timers[id];
      }
    };
  }, []);

  /** What every content edit owes: image references, autosave, recovery snapshot, repaint. */
  const afterEdit = useCallback(
    (id: string, dirty: boolean, autosave: boolean, refreshStats = false) => {
      void prepareCurrentImages(id, true).catch((error) => console.warn('图片引用准备失败', error));
      if (autosave) scheduleAutoSave(id);
      const changed = tabsRef.current.find((tab) => tab.id === id);
      if (changed && (dirty || changed.isNew || changed.preserveLocal))
        saveRecoverySnapshot(changed);
      else if (changed) void deleteRecoverySnapshot(id);
      scheduleTabRender(id, refreshStats);
    },
    [
      tabsRef,
      prepareCurrentImages,
      scheduleAutoSave,
      saveRecoverySnapshot,
      deleteRecoverySnapshot,
      scheduleTabRender,
    ],
  );

  const handleEditorActivity = useCallback(
    (id: string, activity: Pick<EditorUpdate, 'canUndo' | 'canRedo'>) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === id);
      if (!tab) return;
      runtimeOf(id).contentVersion = (tabRuntime.current[id]?.contentVersion ?? 0) + 1;
      const mirror = tabRuntime.current[id]?.mirror;
      if (mirror) runtimeOf(id).mirror = { ...mirror, ...activity };
      tabsRef.current = tabsRef.current.map((candidate) =>
        candidate.id === id ? { ...candidate, dirty: true } : candidate,
      );
      scheduleAutoSave(id);
      scheduleTabRender(id);
    },
    [tabRuntime, runtimeOf, scheduleAutoSave, scheduleTabRender, tabsRef],
  );

  const handleTabUpdate = useCallback(
    (id: string, update: EditorUpdate, isInitial = false, coalesced = false) => {
      const prev = tabsRef.current.find((t) => t.id === id);
      const generation = tabRuntime.current[id]?.contentVersion ?? 0;
      const latest = tabRuntime.current[id]?.mirror?.markdown;
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
      runtimeOf(id).mirror = currentUpdate;
      if (isInitial) {
        runtimeOf(id).contentVersion ??= 0;
      } else if (!coalesced) {
        runtimeOf(id).contentVersion = (tabRuntime.current[id]?.contentVersion ?? 0) + 1;
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
        if (tab && needsDocumentProtection(tab)) saveRecoverySnapshot(tab);
        setTabs([...tabsRef.current]);
        return;
      }
      afterEdit(id, dirty, dirty && !coalesced);
    },
    [
      tabRuntime,
      runtimeOf,
      tabsRef,
      saveRecoverySnapshot,
      scheduleTabRender,
      syncEditor,
      setTabs,
      afterEdit,
    ],
  );

  const registerEditor = useCallback(
    (id: string, editor: Editor | null) => {
      runtimeOf(id).editor = editor;
      if (editor) restoreSessionPosition(id);
      else sessionRestoreCleanups.current[id]?.();
    },
    [runtimeOf, restoreSessionPosition],
  );

  /* ---------- 图片粘贴处理 ---------- */
  const handleImagePaste = useCallback(
    async (tabId: string, file: File): Promise<string> => {
      let imagePath: string | undefined;
      const lifetime = tabEpoch(tabId);
      const isCurrent = () =>
        tabEpoch(tabId) === lifetime && tabsRef.current.some((tab) => tab.id === tabId);
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
    [tabEpoch, tabsRef],
  );

  /* ---------- 撤销 / 重做 ---------- */
  const handleUndo = useCallback(() => {
    const editor = activeId ? tabRuntime.current[activeId]?.editor : null;
    if (editor) undo(editor);
  }, [activeId, tabRuntime]);

  const handleRedo = useCallback(() => {
    const editor = activeId ? tabRuntime.current[activeId]?.editor : null;
    if (editor) redo(editor);
  }, [activeId, tabRuntime]);

  /* ---------- 源码模式 ---------- */
  const toggleSourceMode = useCallback(() => {
    const { activeId: id, sourceMode: wasSource } = currentView.current;
    const pendingEditor = id ? tabRuntime.current[id]?.editor : null;
    if (pendingEditor) flushEditorUpdate(pendingEditor);
    rememberActive();
    if (id && wasSource) {
      const tab = tabsRef.current.find((tab) => tab.id === id);
      const input = tabRuntime.current[id]?.sourceInput;
      const editor = tabRuntime.current[id]?.editor;
      const markdown = tabRuntime.current[id]?.mirror?.markdown ?? tab?.markdown ?? '';
      const saved = (runtimeOf(id).position ??= {});
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
        saveRecoverySnapshot(current);
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
    tabRuntime,
    runtimeOf,
    syncEditor,
    resolveContent,
    saveRecoverySnapshot,
    setSearchOpen,
  ]);

  const handleSourceChange = useCallback(
    (id: string, text: string) => {
      const activeId = id;
      if (activeId) {
        runtimeOf(activeId).contentVersion =
          (tabRuntime.current[activeId]?.contentVersion ?? 0) + 1;
        const prev = tabsRef.current.find((t) => t.id === activeId);
        const dirty = prev ? text !== prev.savedContent : true;
        runtimeOf(activeId).mirror = {
          ...(tabRuntime.current[activeId]?.mirror ?? {
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
        afterEdit(activeId, dirty, dirty, true);
      }
    },
    [tabRuntime, runtimeOf, tabsRef, afterEdit],
  );

  return {
    editorAreaRef,
    handleTabUpdate,
    handleEditorActivity,
    registerEditor,
    handleImagePaste,
    handleUndo,
    handleRedo,
    toggleSourceMode,
    handleSourceChange,
  };
}
