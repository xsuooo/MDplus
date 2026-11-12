import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_DOCUMENT_SESSION,
  mergeSessionDocuments,
  type SavedDocumentSession,
  type SessionDocument,
  type SessionRestoreFailure,
} from '../lib/documentSession';
import { errorMessage } from '../lib/errors';
import { flushEditorUpdate } from '../lib/editorUpdates';
import { pathKey } from '../lib/pathIdentity';
import { loadDocumentSession, saveDocumentSession, setSessionRestoreEnabled } from '../lib/store';
import type { Tab } from '../lib/types';
import type { DocumentSession } from './useDocumentSession';

export interface WindowSessionController {
  captureClosingSession: () => void;
  updateClosingTab: (tab: Tab) => void;
  commitClosingSession: () => Promise<void>;
  cancelClosingSession: () => void;
  forgetClosedTab?: (tab: Tab) => void;
}
interface ClosingDocument {
  id: string;
  document: SessionDocument | null;
}
interface ClosingSession {
  activeId: string | null;
  documents: ClosingDocument[];
  startupIncomplete: boolean;
}
const POSITION_SAVE_DELAY = 500;

/** Coordinates metadata persistence independently of the manual draft-recovery journal. */
export function useSessionPersistence(session: DocumentSession) {
  const {
    tabs,
    activeId,
    sourceMode,
    tabsRef,
    currentView,
    editorRegistry,
    rememberActive,
    captureTabPlace,
  } = session;
  const [sessionRestoreEnabled, setEnabled] = useState(true);
  const enabled = useRef(true);
  const preferenceChanged = useRef(false);
  const preferenceVersion = useRef(0);
  const [sessionFailures, setFailures] = useState<SessionRestoreFailure[]>([]);
  const failedDocuments = useRef(new Map<string, { document: SessionDocument; message: string }>());
  const closedPaths = useRef(new Set<string>());
  const readFailed = useRef(false);
  const writeFailed = useRef(false);
  const lastSession = useRef<SavedDocumentSession>({ ...EMPTY_DOCUMENT_SESSION, documents: [] });
  const startupRead = useRef<Promise<{ enabled: boolean; session: SavedDocumentSession }> | null>(
    null,
  );
  const startupComplete = useRef(false);
  const startupBarrier = useMemo(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }, []);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const closing = useRef<ClosingSession | null>(null);
  const cancelledFingerprint = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const publishFailures = useCallback(() => {
    if (!alive.current) return;
    const failures: SessionRestoreFailure[] = [...failedDocuments.current.values()].map(
      ({ document, message }) => ({ path: document.path, title: document.title, message }),
    );
    if (readFailed.current)
      failures.unshift({
        path: '',
        title: '上次会话',
        message: '会话记录暂时无法读取。可重试；现有记录未被覆盖。',
      });
    if (writeFailed.current)
      failures.unshift({
        path: '',
        title: '会话记录',
        message: '会话记录保存失败。可重试；文稿内容不受影响。',
      });
    setFailures((previous) =>
      previous.length === failures.length &&
      previous.every(
        (entry, index) =>
          entry.path === failures[index].path &&
          entry.title === failures[index].title &&
          entry.message === failures[index].message,
      )
        ? previous
        : failures,
    );
  }, []);
  const recordSessionFailure = useCallback(
    (document: SessionDocument, error: unknown) => {
      failedDocuments.current.set(pathKey(document.path), {
        document,
        message: errorMessage(error),
      });
      if (
        !lastSession.current.documents.some(
          (entry) => pathKey(entry.path) === pathKey(document.path),
        )
      )
        lastSession.current.documents.push(document);
      publishFailures();
    },
    [publishFailures],
  );
  const resolveSessionFailure = useCallback(
    (requestedPath: string, canonicalPath = requestedPath) => {
      failedDocuments.current.delete(pathKey(requestedPath));
      failedDocuments.current.delete(pathKey(canonicalPath));
      publishFailures();
    },
    [publishFailures],
  );
  const sessionDocument = useCallback(
    (tab: Tab): SessionDocument | null => {
      if (!tab.path) return null;
      const editor = editorRegistry.current[tab.id];
      if (editor) flushEditorUpdate(editor);
      const place = captureTabPlace(tab.id);
      return { path: tab.path, title: tab.title, ...(place ? { place } : {}) };
    },
    [captureTabPlace, editorRegistry],
  );
  const fingerprint = useCallback(
    () => JSON.stringify(tabsRef.current.map((tab) => [tab.id, tab.path])),
    [tabsRef],
  );
  const captureLiveSession = useCallback((): SavedDocumentSession => {
    rememberActive();
    const live = tabsRef.current
      .map(sessionDocument)
      .filter((entry): entry is SessionDocument => !!entry);
    const retained = [...failedDocuments.current.values()].map((entry) => entry.document);
    const documents = mergeSessionDocuments(live, retained, lastSession.current.documents);
    const active = tabsRef.current.find((tab) => tab.id === currentView.current.activeId)?.path;
    return { version: 1, documents, activePath: active ?? null };
  }, [currentView, rememberActive, sessionDocument, tabsRef]);
  const persistCurrentSession = useCallback(async () => {
    if (
      !isTauri() ||
      !startupComplete.current ||
      readFailed.current ||
      !enabled.current ||
      closing.current
    )
      return;
    const currentFingerprint = fingerprint();
    // Confirmation removes runtime tabs. Cancel/failed exit cannot persist that partial queue.
    if (cancelledFingerprint.current === currentFingerprint) return;
    cancelledFingerprint.current = null;
    const snapshot = captureLiveSession();
    lastSession.current = snapshot;
    try {
      await saveDocumentSession(snapshot);
      writeFailed.current = false;
    } catch {
      writeFailed.current = true;
    }
    publishFailures();
  }, [captureLiveSession, fingerprint, publishFailures]);
  const scheduleSessionWrite = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (closing.current || !startupComplete.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void persistCurrentSession();
    }, POSITION_SAVE_DELAY);
  }, [persistCurrentSession]);

  const readStoredSession = useCallback(() => {
    if (!isTauri())
      return Promise.resolve({ enabled: enabled.current, session: lastSession.current });
    if (startupRead.current) return startupRead.current;
    const operation = loadDocumentSession()
      .then((loaded) => {
        const documents = loaded.session.documents.filter(
          (entry) => !closedPaths.current.has(pathKey(entry.path)),
        );
        const snapshot: SavedDocumentSession = {
          ...loaded.session,
          documents,
          activePath: documents.some((entry) => entry.path === loaded.session.activePath)
            ? loaded.session.activePath
            : null,
        };
        lastSession.current = snapshot;
        if (!preferenceChanged.current) {
          enabled.current = loaded.enabled;
          if (alive.current) setEnabled(loaded.enabled);
        }
        readFailed.current = false;
        publishFailures();
        return { enabled: enabled.current, session: snapshot };
      })
      .catch((error: unknown) => {
        startupRead.current = null;
        readFailed.current = true;
        publishFailures();
        throw error;
      });
    startupRead.current = operation;
    return operation;
  }, [publishFailures]);
  const completeSessionStartup = useCallback(() => {
    startupComplete.current = true;
    startupBarrier.resolve();
    if (alive.current) setPersistenceReady(true);
    scheduleSessionWrite();
  }, [scheduleSessionWrite, startupBarrier]);
  const adoptSessionPath = useCallback(
    (requestedPath: string, tab: Tab) => {
      if (!tab.path) return;
      const originalKey = pathKey(requestedPath);
      const canonicalKey = pathKey(tab.path);
      closedPaths.current.delete(originalKey);
      closedPaths.current.delete(canonicalKey);
      const original = lastSession.current.documents.find(
        (entry) => pathKey(entry.path) === originalKey,
      );
      if (original) {
        original.path = tab.path;
        original.title = tab.title;
      }
      if (original)
        lastSession.current.documents = lastSession.current.documents.filter(
          (entry) => entry === original || pathKey(entry.path) !== canonicalKey,
        );
      if (lastSession.current.activePath && pathKey(lastSession.current.activePath) === originalKey)
        lastSession.current.activePath = tab.path;
      resolveSessionFailure(requestedPath, tab.path);
    },
    [resolveSessionFailure],
  );

  const changeSessionRestore = useCallback(
    async (next: boolean) => {
      const previous = enabled.current;
      const version = ++preferenceVersion.current;
      preferenceChanged.current = true;
      enabled.current = next;
      setEnabled(next);
      if (!isTauri()) return;
      try {
        await setSessionRestoreEnabled(next);
        if (version === preferenceVersion.current && next) scheduleSessionWrite();
      } catch (error) {
        if (version === preferenceVersion.current) {
          enabled.current = previous;
          if (alive.current) setEnabled(previous);
        }
        throw error;
      }
    },
    [scheduleSessionWrite],
  );

  const captureClosingSession = useCallback(() => {
    if (!isTauri()) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    rememberActive();
    closing.current = {
      activeId: currentView.current.activeId,
      startupIncomplete: !startupComplete.current,
      documents: tabsRef.current.map((tab) => ({
        id: tab.id,
        document: structuredClone(sessionDocument(tab)),
      })),
    };
  }, [currentView, rememberActive, sessionDocument, tabsRef]);
  const updateClosingTab = useCallback(
    (tab: Tab) => {
      const snapshot = closing.current;
      if (!snapshot) return;
      const captured = snapshot.documents.find((entry) => entry.id === tab.id);
      const document = structuredClone(sessionDocument(tab));
      if (captured) captured.document = document;
      else snapshot.documents.push({ id: tab.id, document });
    },
    [sessionDocument],
  );
  const cancelClosingSession = useCallback(() => {
    closing.current = null;
    cancelledFingerprint.current = fingerprint();
  }, [fingerprint]);
  const forgetClosedTab = useCallback(
    (tab: Tab) => {
      if (!tab.path) return;
      const key = pathKey(tab.path);
      closedPaths.current.add(key);
      failedDocuments.current.delete(key);
      lastSession.current.documents = lastSession.current.documents.filter(
        (entry) => pathKey(entry.path) !== key,
      );
      if (lastSession.current.activePath && pathKey(lastSession.current.activePath) === key)
        lastSession.current.activePath = null;
      publishFailures();
    },
    [publishFailures],
  );
  const commitClosingSession = useCallback(async () => {
    const snapshot = closing.current;
    if (!snapshot || !isTauri() || !enabled.current) return;
    if (!startupComplete.current) await startupBarrier.promise;
    if (!alive.current || closing.current !== snapshot) return;
    // A failed first settings read must be retried before any metadata is replaced.
    if (readFailed.current) {
      const loaded = await readStoredSession();
      // These paths were unknown at beginWindowClose. They have not been opened
      // or explicitly closed, so preserve them rather than committing only CLI tabs.
      if (loaded.enabled)
        for (const entry of loaded.session.documents) {
          const key = pathKey(entry.path);
          if (
            !snapshot.documents.some(
              (candidate) => candidate.document && pathKey(candidate.document.path) === key,
            ) &&
            !tabsRef.current.some((tab) => tab.path && pathKey(tab.path) === key)
          )
            recordSessionFailure(
              entry,
              new Error('会话记录已重新读取，此文稿尚未恢复，可重试打开。'),
            );
        }
    }
    if (!enabled.current || closing.current !== snapshot) return;
    for (const tab of tabsRef.current) updateClosingTab(tab);
    if (snapshot.startupIncomplete) {
      const ordinal = new Map(
        lastSession.current.documents.map((entry, index) => [pathKey(entry.path), index]),
      );
      snapshot.documents.sort(
        (first, second) =>
          (first.document ? (ordinal.get(pathKey(first.document.path)) ?? Infinity) : Infinity) -
          (second.document ? (ordinal.get(pathKey(second.document.path)) ?? Infinity) : Infinity),
      );
    }
    const live = snapshot.documents
      .map((entry) => entry.document)
      .filter((entry): entry is SessionDocument => !!entry);
    const documents = mergeSessionDocuments(
      live,
      [...failedDocuments.current.values()].map((entry) => entry.document),
      lastSession.current.documents,
    );
    const activePath =
      snapshot.documents.find((entry) => entry.id === snapshot.activeId)?.document?.path ??
      documents[documents.length - 1]?.path ??
      null;
    const next: SavedDocumentSession = { version: 1, documents, activePath };
    await saveDocumentSession(next);
    lastSession.current = next;
    writeFailed.current = false;
    publishFailures();
  }, [
    publishFailures,
    readStoredSession,
    recordSessionFailure,
    startupBarrier,
    tabsRef,
    updateClosingTab,
  ]);
  const sessionController = useMemo<WindowSessionController>(
    () => ({
      captureClosingSession,
      updateClosingTab,
      commitClosingSession,
      cancelClosingSession,
      forgetClosedTab,
    }),
    [
      captureClosingSession,
      updateClosingTab,
      commitClosingSession,
      cancelClosingSession,
      forgetClosedTab,
    ],
  );

  const retrySessionPersistence = useCallback(async () => {
    const loaded = readFailed.current ? await readStoredSession() : null;
    if (writeFailed.current) {
      cancelledFingerprint.current = null;
      await persistCurrentSession();
    }
    return loaded;
  }, [persistCurrentSession, readStoredSession]);
  const getFailedSessionDocuments = useCallback(
    () => [...failedDocuments.current.values()].map((entry) => entry.document),
    [],
  );
  const getSavedSession = useCallback(() => lastSession.current, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // StrictMode immediately replays effects. Resolve only for a real unmount,
      // so an early close still waits for the replayed startup work to finish.
      queueMicrotask(() => {
        if (!alive.current) startupBarrier.resolve();
      });
      if (timer.current) clearTimeout(timer.current);
    };
  }, [startupBarrier]);
  useEffect(() => {
    if (persistenceReady) scheduleSessionWrite();
  }, [tabs, activeId, sourceMode, persistenceReady, scheduleSessionWrite]);
  useEffect(() => {
    if (!isTauri()) return;
    // Source selection/scroll and rich-editor reading positions do not necessarily render React.
    const capture = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('.editor-area')) scheduleSessionWrite();
    };
    for (const type of ['scroll', 'select', 'selectionchange', 'input', 'keyup', 'pointerup'])
      document.addEventListener(type, capture, true);
    return () => {
      for (const type of ['scroll', 'select', 'selectionchange', 'input', 'keyup', 'pointerup'])
        document.removeEventListener(type, capture, true);
    };
  }, [scheduleSessionWrite]);

  return {
    sessionRestoreEnabled,
    changeSessionRestore,
    sessionFailures,
    sessionController,
    readStoredSession,
    completeSessionStartup,
    recordSessionFailure,
    resolveSessionFailure,
    adoptSessionPath,
    retrySessionPersistence,
    getFailedSessionDocuments,
    getSavedSession,
  };
}
