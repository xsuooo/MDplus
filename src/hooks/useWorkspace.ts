import type { Editor } from '@milkdown/kit/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { setMarkdown } from '../lib/editor';
import {
  captureRenderedSessionPlace,
  captureSourceSessionPlace,
  renderedPlace,
  renderedSessionPlace,
  sourcePlace,
  sourceSessionPlace,
  type ModeExchange,
  type RenderedPlace,
  type SourcePlace,
} from '../lib/position/editorPosition';
import { textAnchor, type SessionEditorPlace } from '../lib/position/sessionPosition';
import { clearPendingImages } from '../lib/imageOps';
import { type UrlRewrite } from '../lib/imagePaths';
import { type ImagePreparation } from '../lib/imagePreparation';
import { computeStats } from '../lib/stats';
import type { EditorUpdate, Tab } from '../lib/types';

export interface DiskSync {
  /** undefined: autosave runs. null: paused, no disk mtime known. number: paused by that disk mtime. */
  pausedMtime?: number | null;
  /** The changed disk version last offered to the user. */
  detected?: { revision: string | null; mtime: number };
  checking?: boolean;
  prompting?: boolean;
}

export interface TabPosition {
  sourceMode?: boolean;
  source?: SourcePlace;
  rendered?: RenderedPlace;
  exchange?: ModeExchange;
  sessionPlace?: SessionEditorPlace;
  sessionCapture?: () => SessionEditorPlace;
  pendingSessionPlace?: SessionEditorPlace;
}

/** Per-tab state kept outside React. Every field is absent until first used. */
export interface TabRuntime {
  editor?: Editor | null;
  sourceInput?: HTMLTextAreaElement | null;
  /** Latest content published by the editor, ahead of the rendered tabs by up to TAB_RENDER_MS. */
  mirror?: EditorUpdate;
  /** Bumped on every edit; async steps compare it before and after to detect new edits. */
  contentVersion?: number;
  saveTimer?: ReturnType<typeof setTimeout>;
  /** Present while a save is queued or running. */
  saveQueue?: Promise<boolean>;
  /** Bumped on each rich/source switch; invalidates image drops that span a switch. */
  modeGeneration?: number;
  sourceRewrites?: UrlRewrite[];
  imagePreparation?: ImagePreparation & {
    version: number;
    content: string;
    path: string | null;
    revision: string | null;
  };
  disk?: DiskSync;
  position?: TabPosition;
}

export function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function useWorkspace(initialTabs: Tab[] = []) {
  const [tabs, setTabs] = useState<Tab[]>(initialTabs);
  const [activeId, setActiveId] = useState<string | null>(initialTabs[0]?.id ?? null);
  const [sourceMode, setSourceModeState] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [positionVersion, setPositionVersion] = useState(0);
  const tabsRef = useRef<Tab[]>(initialTabs);
  // Outlives the tab on purpose: bumped when a tab closes or its queued saves must be dropped, so an
  // async step can tell that the id it started with no longer means the same document.
  const epochs = useRef<Record<string, number>>({});
  const tabEpoch = useCallback((id: string) => epochs.current[id] ?? 0, []);
  const invalidateSaves = useCallback((id: string) => {
    epochs.current[id] = (epochs.current[id] ?? 0) + 1;
  }, []);
  // All per-tab state that is not rendered. removeTab drops the whole record. See docs/state-model.md.
  const tabRuntime = useRef<Record<string, TabRuntime>>({});
  const runtimeOf = useCallback((id: string) => (tabRuntime.current[id] ??= {}), []);
  const diskOf = useCallback((id: string) => (runtimeOf(id).disk ??= {}), [runtimeOf]);
  const isAutoSavePaused = useCallback(
    (id: string) => tabRuntime.current[id]?.disk?.pausedMtime !== undefined,
    [],
  );
  const resumeAutoSave = useCallback((id: string) => {
    const disk = tabRuntime.current[id]?.disk;
    if (!disk) return;
    delete disk.pausedMtime;
    delete disk.detected;
  }, []);
  const currentView = useRef({ activeId, sourceMode });
  currentView.current = { activeId, sourceMode };
  const setSourceMode = useCallback(
    (source: boolean) => {
      const current = currentView.current;
      if (current.activeId && current.sourceMode !== source)
        runtimeOf(current.activeId).modeGeneration =
          (tabRuntime.current[current.activeId]?.modeGeneration ?? 0) + 1;
      current.sourceMode = source;
      setSourceModeState(source);
    },
    [runtimeOf],
  );
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) ?? null, [tabs, activeId]);
  const syncEditor = useCallback(
    (id: string, markdown: string, history = true) => {
      const editor = tabRuntime.current[id]?.editor;
      if (!editor) return;
      const update = setMarkdown(editor, markdown, history);
      if (update) runtimeOf(id).mirror = { ...update, markdown, stats: computeStats(markdown) };
    },
    [runtimeOf],
  );
  const rememberActive = useCallback(() => {
    const { activeId: id, sourceMode: source } = currentView.current;
    if (!id) return;
    const saved = (runtimeOf(id).position ??= {});
    saved.sourceMode = source;
    const input = tabRuntime.current[id]?.sourceInput;
    const editor = tabRuntime.current[id]?.editor;
    if (source && input) saved.source = sourcePlace(input);
    else if (editor) {
      try {
        saved.rendered = renderedPlace(editor);
      } catch (error) {
        console.warn('文稿位置读取暂不可用', error);
      }
    }
  }, [runtimeOf]);
  const captureTabPlace = useCallback(
    (id: string): SessionEditorPlace | undefined => {
      const tab = tabsRef.current.find((candidate) => candidate.id === id);
      if (!tab) return;
      const saved = (runtimeOf(id).position ??= {});
      const source =
        currentView.current.activeId === id
          ? currentView.current.sourceMode
          : (saved.sourceMode ?? false);
      // A restored tab whose view has not mounted still owns its original anchors.
      if (saved.pendingSessionPlace) return saved.pendingSessionPlace;
      const active = currentView.current.activeId === id;
      if (!active && saved.sessionPlace && !saved.sessionCapture) return saved.sessionPlace;
      const markdown = tabRuntime.current[id]?.mirror?.markdown ?? tab.markdown;
      const input = tabRuntime.current[id]?.sourceInput;
      const editor = tabRuntime.current[id]?.editor;
      try {
        if (!active && saved.sessionCapture) {
          saved.sessionPlace = saved.sessionCapture();
          delete saved.sessionCapture;
        } else if (source && input && active)
          saved.sessionPlace = sourceSessionPlace(input, markdown);
        else if (!source && editor) saved.sessionPlace = renderedSessionPlace(editor, markdown);
        else if (source && saved.source)
          saved.sessionPlace = {
            sourceMode: true,
            start: textAnchor(markdown, saved.source.start),
            end: textAnchor(markdown, saved.source.end),
            direction: saved.source.direction,
            top: saved.source.top,
            left: saved.source.left,
          };
        if (active) delete saved.sessionCapture;
      } catch (error) {
        // The editor can be registering or tearing down. Keep its last usable position.
        console.warn('文稿位置读取暂不可用', error);
      }
      return saved.sessionPlace;
    },
    [runtimeOf],
  );
  const selectTab = useCallback(
    (id: string | null) => {
      if (currentView.current.activeId === id) return;
      rememberActive();
      const previousId = currentView.current.activeId;
      const previous = tabsRef.current.find((tab) => tab.id === previousId);
      if (previous) {
        const saved = (runtimeOf(previous.id).position ??= {});
        const markdown = tabRuntime.current[previous.id]?.mirror?.markdown ?? previous.markdown;
        const input = tabRuntime.current[previous.id]?.sourceInput;
        const editor = tabRuntime.current[previous.id]?.editor;
        // Switching only freezes inputs; persistence and close flush the exact same snapshot.
        if (!saved.pendingSessionPlace)
          try {
            if (currentView.current.sourceMode && input)
              saved.sessionCapture = captureSourceSessionPlace(input, markdown);
            else if (editor) saved.sessionCapture = captureRenderedSessionPlace(editor, markdown);
          } catch (error) {
            console.warn('文稿位置读取暂不可用', error);
          }
      }
      const source = id ? (tabRuntime.current[id]?.position?.sourceMode ?? false) : false;
      currentView.current = { activeId: id, sourceMode: source };
      setActiveId(id);
      setSourceModeState(source);
    },
    [rememberActive, runtimeOf],
  );
  const registerSource = useCallback(
    (id: string, input: HTMLTextAreaElement | null) => {
      runtimeOf(id).sourceInput = input;
    },
    [runtimeOf],
  );
  const installSessionPlace = useCallback(
    (id: string, place: SessionEditorPlace) => {
      if ((tabRuntime.current[id]?.contentVersion ?? 0) > 0) return;
      const saved = (runtimeOf(id).position ??= {});
      // A user's live position takes precedence over a late session read.
      if ((saved.sessionPlace || saved.sessionCapture) && !saved.pendingSessionPlace) return;
      saved.sourceMode = place.sourceMode;
      saved.sessionPlace = place;
      saved.pendingSessionPlace = place;
      if (currentView.current.activeId === id) {
        setSourceMode(place.sourceMode);
      }
      setPositionVersion((version) => version + 1);
    },
    [runtimeOf, setSourceMode],
  );
  /** Save, close, export and mode switches flush pending rich edits before reading this mirror. */
  const resolveContent = useCallback((tab: Tab): string => {
    return tabRuntime.current[tab.id]?.mirror?.markdown ?? tab.markdown;
  }, []);

  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    tabsRef.current = tabsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t));
    setTabs([...tabsRef.current]);
  }, []);

  const pauseAutoSave = useCallback(
    (id: string, mtime: number | null) => {
      diskOf(id).pausedMtime = mtime;
      // Keep dirty tied to edits so later disk revisions are still polled, but do
      // not let close/recovery mistake the retained buffer for a backed-up copy.
      tabsRef.current = tabsRef.current.map((tab) =>
        tab.id === id ? { ...tab, preserveLocal: true } : tab,
      );
      setTabs([...tabsRef.current]);
    },
    [diskOf],
  );

  const addTab = useCallback(
    (
      init: {
        title: string;
        path: string | null;
        isNew: boolean;
        content: string;
        mtime?: number;
        revision?: string;
        recovered?: boolean;
        activate?: boolean;
        place?: SessionEditorPlace;
      },
      id: string = makeId(),
    ) => {
      // Identity is a session invariant, not a responsibility of each async caller.
      if (tabsRef.current.some((tab) => tab.id === id)) {
        selectTab(id);
        return id;
      }
      const tab: Tab = {
        id,
        title: init.title,
        path: init.path,
        isNew: init.isNew,
        dirty: !!init.recovered,
        diskMtime: init.mtime ?? 0,
        diskRevision: init.revision ?? null,
        externalChanged: false,
        preserveLocal: false,
        initialContent: init.content,
        savedContent: init.recovered ? '' : init.content,
        markdown: init.content,
        stats: computeStats(init.content),
      };
      if (init.place)
        runtimeOf(id).position = {
          sourceMode: init.place.sourceMode,
          sessionPlace: init.place,
          pendingSessionPlace: init.place,
        };
      runtimeOf(id).contentVersion = 0;
      tabsRef.current = [...tabsRef.current, tab];
      setTabs([...tabsRef.current]);
      if (init.activate !== false) {
        selectTab(id);
        setSearchOpen(false);
      }
      return id;
    },
    [runtimeOf, selectTab],
  );

  const removeTab = useCallback((id: string) => {
    // 同步更新 tabsRef,确保关闭窗口流程里 onCloseRequested 能读到最新状态,
    // 否则保存后再次 close() 会因读到旧 dirty 标签而再次拦截,陷入死循环
    tabsRef.current = tabsRef.current.filter((t) => t.id !== id);
    epochs.current[id] = (epochs.current[id] ?? 0) + 1;
    tabRuntime.current[id]?.imagePreparation?.cancel();
    setTabs([...tabsRef.current]);
    clearPendingImages(id);
    const timer = tabRuntime.current[id]?.saveTimer;
    if (timer) clearTimeout(timer);
    delete tabRuntime.current[id];
    if (currentView.current.activeId === id) {
      const next = tabsRef.current[tabsRef.current.length - 1];
      const source = next ? (tabRuntime.current[next.id]?.position?.sourceMode ?? false) : false;
      currentView.current = { activeId: next?.id ?? null, sourceMode: source };
      setSourceModeState(source);
      setActiveId(next?.id ?? null);
    }
  }, []);

  return {
    tabs,
    setTabs,
    activeId,
    sourceMode,
    setSourceMode,
    searchOpen,
    setSearchOpen,
    positionVersion,
    activeTab,
    tabsRef,
    tabEpoch,
    invalidateSaves,
    tabRuntime,
    runtimeOf,
    diskOf,
    isAutoSavePaused,
    resumeAutoSave,
    currentView,
    syncEditor,
    rememberActive,
    captureTabPlace,
    selectTab,
    registerSource,
    installSessionPlace,
    resolveContent,
    updateTab,
    pauseAutoSave,
    addTab,
    removeTab,
  };
}
export type Workspace = ReturnType<typeof useWorkspace>;
