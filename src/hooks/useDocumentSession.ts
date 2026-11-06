import type { Editor } from '@milkdown/kit/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { setMarkdown } from '../lib/editor';
import {
  renderedPlace,
  sourcePlace,
  type ModeExchange,
  type RenderedPlace,
  type SourcePlace,
} from '../lib/editorPosition';
import { clearPendingImages } from '../lib/imageOps';
import { type PendingImageReference } from '../lib/imagePaths';
import { type ImagePreparation } from '../lib/imagePreparation';
import { computeStats } from '../lib/stats';
import type { EditorUpdate, Tab } from '../lib/types';

export function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function useDocumentSession(initialTabs: Tab[] = []) {
  const [tabs, setTabs] = useState<Tab[]>(initialTabs);
  const [activeId, setActiveId] = useState<string | null>(initialTabs[0]?.id ?? null);
  const [sourceMode, setSourceMode] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const editorRegistry = useRef<Record<string, Editor | null>>({});
  const tabMirror = useRef<Record<string, EditorUpdate>>({});
  const tabsRef = useRef<Tab[]>(initialTabs);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saveQueues = useRef<Record<string, Promise<boolean>>>({});
  const saveGenerations = useRef<Record<string, number>>({});
  const contentGenerations = useRef<Record<string, number>>({});
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
  const blockedExternalMtime = useRef<Record<string, number>>({});
  const detectedExternalStates = useRef<Record<string, { revision: string | null; mtime: number }>>(
    {},
  );
  const openingPaths = useRef(new Set<string>());
  const externalChecks = useRef(new Set<string>());
  const externalPrompts = useRef(new Set<string>());
  const tabRenderTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const currentView = useRef({ activeId, sourceMode });
  const sourceRegistry = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const sourceRewrites = useRef<Record<string, PendingImageReference[]>>({});
  const positions = useRef<
    Record<
      string,
      {
        sourceMode?: boolean;
        source?: SourcePlace;
        rendered?: RenderedPlace;
        exchange?: ModeExchange;
      }
    >
  >({});
  const enteringSource = useRef(false);
  currentView.current = { activeId, sourceMode };
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
    else if (editor) saved.rendered = renderedPlace(editor);
  }, []);
  const selectTab = useCallback(
    (id: string | null) => {
      if (currentView.current.activeId === id) return;
      rememberActive();
      setActiveId(id);
      setSourceMode(id ? (positions.current[id]?.sourceMode ?? false) : false);
    },
    [rememberActive],
  );
  const registerSource = useCallback((id: string, input: HTMLTextAreaElement | null) => {
    sourceRegistry.current[id] = input;
  }, []);
  /** Editor transactions and source input update this mirror before any render throttle. */
  const resolveContent = useCallback((tab: Tab): string => {
    return tabMirror.current[tab.id]?.markdown ?? tab.markdown;
  }, []);

  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    tabsRef.current = tabsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t));
    setTabs([...tabsRef.current]);
  }, []);

  const pauseAutoSave = useCallback((id: string, mtime: number) => {
    blockedExternalMtime.current[id] = mtime;
    // Keep dirty tied to edits so later disk revisions are still polled, but do
    // not let close/recovery mistake the retained buffer for a backed-up copy.
    tabsRef.current = tabsRef.current.map((tab) =>
      tab.id === id ? { ...tab, preserveLocal: true } : tab,
    );
    setTabs([...tabsRef.current]);
  }, []);

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
        externalMtime: init.mtime ?? 0,
        diskRevision: init.revision ?? null,
        externalChanged: false,
        preserveLocal: false,
        initialContent: init.content,
        savedContent: init.recovered ? '' : init.content,
        markdown: init.content,
        stats: computeStats(init.content),
      };
      contentGenerations.current[id] = 0;
      tabsRef.current = [...tabsRef.current, tab];
      setTabs([...tabsRef.current]);
      selectTab(id);
      setSearchOpen(false);
      setSourceMode(false);
      return id;
    },
    [selectTab],
  );

  const removeTab = useCallback((id: string) => {
    // 同步更新 tabsRef,确保关闭窗口流程里 onCloseRequested 能读到最新状态,
    // 否则保存后再次 close() 会因读到旧 dirty 标签而再次拦截,陷入死循环
    tabsRef.current = tabsRef.current.filter((t) => t.id !== id);
    saveGenerations.current[id] = (saveGenerations.current[id] ?? 0) + 1;
    delete contentGenerations.current[id];
    imagePreparations.current[id]?.cancel();
    delete imagePreparations.current[id];
    setTabs([...tabsRef.current]);
    delete editorRegistry.current[id];
    delete tabMirror.current[id];
    delete blockedExternalMtime.current[id];
    delete detectedExternalStates.current[id];
    externalPrompts.current.delete(id);
    clearPendingImages(id);
    delete positions.current[id];
    delete sourceRegistry.current[id];
    delete sourceRewrites.current[id];
    const timer = saveTimers.current[id];
    if (timer) clearTimeout(timer);
    delete saveTimers.current[id];
    if (currentView.current.activeId === id) {
      const next = tabsRef.current[tabsRef.current.length - 1];
      setSourceMode(next ? (positions.current[next.id]?.sourceMode ?? false) : false);
      setActiveId(next?.id ?? null);
    }
  }, []);

  return {
    tabs,
    setTabs,
    activeId,
    setActiveId,
    sourceMode,
    setSourceMode,
    searchOpen,
    setSearchOpen,
    activeTab,
    editorRegistry,
    tabMirror,
    tabsRef,
    saveTimers,
    saveQueues,
    saveGenerations,
    contentGenerations,
    imagePreparations,
    blockedExternalMtime,
    detectedExternalStates,
    openingPaths,
    externalChecks,
    externalPrompts,
    tabRenderTimers,
    currentView,
    sourceRegistry,
    sourceRewrites,
    positions,
    enteringSource,
    syncEditor,
    rememberActive,
    selectTab,
    registerSource,
    resolveContent,
    updateTab,
    pauseAutoSave,
    addTab,
    removeTab,
  };
}
export type DocumentSession = ReturnType<typeof useDocumentSession>;
