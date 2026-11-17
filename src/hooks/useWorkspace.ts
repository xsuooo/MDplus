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
  const editorRegistry = useRef<Record<string, Editor | null>>({});
  const tabMirror = useRef<Record<string, EditorUpdate>>({});
  const tabsRef = useRef<Tab[]>(initialTabs);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saveQueues = useRef<Record<string, Promise<boolean>>>({});
  const saveGenerations = useRef<Record<string, number>>({});
  const contentVersions = useRef<Record<string, number>>({});
  const imagePreparations = useRef<
    Record<
      string,
      ImagePreparation & {
        version: number;
        content: string;
        path: string | null;
        revision: string | null;
      }
    >
  >({});
  // Everything known about one tab's file on disk beyond the Tab fields. See docs/state-model.md.
  const diskSync = useRef<Record<string, DiskSync>>({});
  const diskOf = useCallback((id: string) => (diskSync.current[id] ??= {}), []);
  const isAutoSavePaused = useCallback(
    (id: string) => diskSync.current[id]?.pausedMtime !== undefined,
    [],
  );
  const resumeAutoSave = useCallback((id: string) => {
    const disk = diskSync.current[id];
    if (!disk) return;
    delete disk.pausedMtime;
    delete disk.detected;
  }, []);
  const currentView = useRef({ activeId, sourceMode });
  const modeGenerations = useRef<Record<string, number>>({});
  const sourceRegistry = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const sourceRewrites = useRef<Record<string, UrlRewrite[]>>({});
  const positions = useRef<
    Record<
      string,
      {
        sourceMode?: boolean;
        source?: SourcePlace;
        rendered?: RenderedPlace;
        exchange?: ModeExchange;
        sessionPlace?: SessionEditorPlace;
        sessionCapture?: () => SessionEditorPlace;
        pendingSessionPlace?: SessionEditorPlace;
      }
    >
  >({});
  currentView.current = { activeId, sourceMode };
  const setSourceMode = useCallback((source: boolean) => {
    const current = currentView.current;
    if (current.activeId && current.sourceMode !== source)
      modeGenerations.current[current.activeId] =
        (modeGenerations.current[current.activeId] ?? 0) + 1;
    current.sourceMode = source;
    setSourceModeState(source);
  }, []);
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) ?? null, [tabs, activeId]);
  const syncEditor = useCallback((id: string, markdown: string, history = true) => {
    const editor = editorRegistry.current[id];
    if (!editor) return;
    const update = setMarkdown(editor, markdown, history);
    if (update) tabMirror.current[id] = { ...update, markdown, stats: computeStats(markdown) };
  }, []);
  const rememberActive = useCallback(() => {
    const { activeId: id, sourceMode: source } = currentView.current;
    if (!id) return;
    const saved = (positions.current[id] ??= {});
    saved.sourceMode = source;
    const input = sourceRegistry.current[id];
    const editor = editorRegistry.current[id];
    if (source && input) saved.source = sourcePlace(input);
    else if (editor) {
      try {
        saved.rendered = renderedPlace(editor);
      } catch (error) {
        console.warn('文稿位置读取暂不可用', error);
      }
    }
  }, []);
  const captureTabPlace = useCallback((id: string): SessionEditorPlace | undefined => {
    const tab = tabsRef.current.find((candidate) => candidate.id === id);
    if (!tab) return;
    const saved = (positions.current[id] ??= {});
    const source =
      currentView.current.activeId === id
        ? currentView.current.sourceMode
        : (saved.sourceMode ?? false);
    // A restored tab whose view has not mounted still owns its original anchors.
    if (saved.pendingSessionPlace) return saved.pendingSessionPlace;
    const active = currentView.current.activeId === id;
    if (!active && saved.sessionPlace && !saved.sessionCapture) return saved.sessionPlace;
    const markdown = tabMirror.current[id]?.markdown ?? tab.markdown;
    const input = sourceRegistry.current[id];
    const editor = editorRegistry.current[id];
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
  }, []);
  const selectTab = useCallback(
    (id: string | null) => {
      if (currentView.current.activeId === id) return;
      rememberActive();
      const previousId = currentView.current.activeId;
      const previous = tabsRef.current.find((tab) => tab.id === previousId);
      if (previous) {
        const saved = positions.current[previous.id];
        const markdown = tabMirror.current[previous.id]?.markdown ?? previous.markdown;
        const input = sourceRegistry.current[previous.id];
        const editor = editorRegistry.current[previous.id];
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
      const source = id ? (positions.current[id]?.sourceMode ?? false) : false;
      currentView.current = { activeId: id, sourceMode: source };
      setActiveId(id);
      setSourceModeState(source);
    },
    [rememberActive],
  );
  const registerSource = useCallback((id: string, input: HTMLTextAreaElement | null) => {
    sourceRegistry.current[id] = input;
  }, []);
  const installSessionPlace = useCallback(
    (id: string, place: SessionEditorPlace) => {
      if ((contentVersions.current[id] ?? 0) > 0) return;
      const saved = (positions.current[id] ??= {});
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
    [setSourceMode],
  );
  /** Save, close, export and mode switches flush pending rich edits before reading this mirror. */
  const resolveContent = useCallback((tab: Tab): string => {
    return tabMirror.current[tab.id]?.markdown ?? tab.markdown;
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
        positions.current[id] = {
          sourceMode: init.place.sourceMode,
          sessionPlace: init.place,
          pendingSessionPlace: init.place,
        };
      contentVersions.current[id] = 0;
      tabsRef.current = [...tabsRef.current, tab];
      setTabs([...tabsRef.current]);
      if (init.activate !== false) {
        selectTab(id);
        setSearchOpen(false);
      }
      return id;
    },
    [selectTab],
  );

  const removeTab = useCallback((id: string) => {
    // 同步更新 tabsRef,确保关闭窗口流程里 onCloseRequested 能读到最新状态,
    // 否则保存后再次 close() 会因读到旧 dirty 标签而再次拦截,陷入死循环
    tabsRef.current = tabsRef.current.filter((t) => t.id !== id);
    saveGenerations.current[id] = (saveGenerations.current[id] ?? 0) + 1;
    delete contentVersions.current[id];
    imagePreparations.current[id]?.cancel();
    delete imagePreparations.current[id];
    setTabs([...tabsRef.current]);
    delete editorRegistry.current[id];
    delete tabMirror.current[id];
    delete diskSync.current[id];
    clearPendingImages(id);
    delete positions.current[id];
    delete sourceRegistry.current[id];
    delete sourceRewrites.current[id];
    delete modeGenerations.current[id];
    const timer = saveTimers.current[id];
    if (timer) clearTimeout(timer);
    delete saveTimers.current[id];
    if (currentView.current.activeId === id) {
      const next = tabsRef.current[tabsRef.current.length - 1];
      const source = next ? (positions.current[next.id]?.sourceMode ?? false) : false;
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
    editorRegistry,
    tabMirror,
    tabsRef,
    saveTimers,
    saveQueues,
    saveGenerations,
    contentVersions,
    imagePreparations,
    diskSync,
    diskOf,
    isAutoSavePaused,
    resumeAutoSave,
    currentView,
    modeGenerations,
    sourceRegistry,
    sourceRewrites,
    positions,
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
