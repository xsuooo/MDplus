// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentSession } from '../src/hooks/useDocumentSession';
import { useDocumentFiles } from '../src/hooks/useDocumentFiles';
import { useDocumentClose } from '../src/hooks/useDocumentClose';
import type { SavedDocumentSession } from '../src/lib/documentSession';
import { textAnchor, type SessionEditorPlace } from '../src/lib/sessionPosition';
import { computeStats } from '../src/lib/stats';
import type { Tab } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  native: true,
  startup: [] as string[],
  pending: [] as string[],
  documents: new Map<string, { path: string; content: string; revision: string; mtime: number }>(),
  load: vi.fn(),
  persist: vi.fn(),
  enabled: vi.fn(),
  read: vi.fn(),
  revision: vi.fn(),
  save: vi.fn(),
  clean: vi.fn(),
  protect: vi.fn(),
  destroy: vi.fn(),
  message: vi.fn(),
  windowPersist: vi.fn(),
  waitWindow: vi.fn(),
  invoke: vi.fn(),
  recent: vi.fn(),
  removeRecent: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => mocks.native, invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    destroy: mocks.destroy,
    onCloseRequested: async () => () => {},
  }),
}));
vi.mock('../src/lib/editor', () => ({ setMarkdown: vi.fn() }));
vi.mock('../src/lib/imageOps', () => ({
  clearPendingImages: vi.fn(),
  prepareImageReferences: async () => ({ commit: () => true, dispose: async () => {} }),
}));
vi.mock('../src/lib/dialog', () => ({ showMessage: mocks.message }));
vi.mock('../src/services/windowState', () => ({ waitForWindowReady: mocks.waitWindow }));
vi.mock('../src/lib/fileOps', () => ({
  readDocument: mocks.read,
  documentRevision: mocks.revision,
  pickOpenFile: vi.fn(),
  basename: (path: string) => path.split(/[\\/]/).at(-1) ?? path,
}));
vi.mock('../src/lib/store', () => ({
  getRecentFiles: mocks.recent,
  pushRecentFile: async () => {},
  removeRecentFile: mocks.removeRecent,
  loadDocumentSession: mocks.load,
  saveDocumentSession: mocks.persist,
  setSessionRestoreEnabled: mocks.enabled,
}));

const path = (name: string) => `C:/notes/${name}.md`;
const snapshot = (...names: string[]): SavedDocumentSession => ({
  version: 1,
  documents: names.map((name) => ({ path: path(name), title: `${name}.md` })),
  activePath: names.length ? path(names[0]) : null,
});
function file(name: string, content = `Latest disk body of ${name}.\n`) {
  const value = { path: path(name), content, revision: `disk:${content}`, mtime: 1 };
  mocks.documents.set(value.path, value);
  return value;
}
function tab(id: string, dirty = false, saved = true): Tab {
  const markdown = `${id} document content\n`;
  return {
    id,
    title: `${id}.md`,
    path: saved ? path(id) : null,
    isNew: !saved,
    dirty,
    markdown,
    savedContent: dirty ? 'previous disk body\n' : markdown,
    initialContent: markdown,
    stats: computeStats(markdown),
    externalMtime: 1,
    diskRevision: saved ? `disk:${id}` : null,
    externalChanged: false,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let step = 0; step < 150; step++) await Promise.resolve();
}
const onClosing = () => {};
function setup(initial: Tab[] = [], strict = false) {
  return renderHook(
    () => {
      const session = useDocumentSession(initial);
      const files = useDocumentFiles(session);
      const close = useDocumentClose(
        session,
        { cleanRecovery: mocks.clean, protectDraft: mocks.protect },
        mocks.save,
        mocks.windowPersist,
        onClosing,
        files.sessionController,
      );
      return { session, files, close };
    },
    {
      wrapper: strict
        ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
        : undefined,
    },
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.native = true;
  mocks.startup = [];
  mocks.pending = [];
  mocks.documents.clear();
  mocks.load.mockResolvedValue({ enabled: true, session: snapshot() });
  mocks.persist.mockResolvedValue(undefined);
  mocks.enabled.mockResolvedValue(undefined);
  mocks.recent.mockResolvedValue([]);
  mocks.removeRecent.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'take_startup_files') return [...mocks.startup];
    if (command === 'take_pending_open_files') return mocks.pending.splice(0);
    throw new Error(`Unexpected session IPC: ${command}`);
  });
  mocks.read.mockImplementation(async (requested: string) => {
    const document = mocks.documents.get(requested);
    if (!document) throw new Error(`Unavailable: ${requested}`);
    return { ...document };
  });
  mocks.revision.mockImplementation(async (requested: string) => {
    const document = mocks.documents.get(requested);
    return document
      ? { path: document.path, revision: document.revision, mtime: document.mtime }
      : { path: requested, revision: null, mtime: null };
  });
  mocks.save.mockResolvedValue(true);
  mocks.clean.mockResolvedValue(true);
  mocks.windowPersist.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.message.mockResolvedValue(undefined);
  // A hidden-window handshake never settles: silent startup failures must not await it.
  mocks.waitWindow.mockImplementation(() => new Promise<void>(() => {}));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('saved-file startup restoration', () => {
  it('keeps original file errors and restores remaining paths when recent-list cleanup also fails', async () => {
    mocks.load.mockResolvedValue({ enabled: true, session: snapshot('a', 'b', 'c') });
    mocks.removeRecent.mockRejectedValueOnce(new Error('recent mutation unavailable'));
    mocks.recent.mockRejectedValueOnce(new Error('initial recent list unavailable'));
    file('c');
    const hook = setup([], true);
    await act(flush);
    expect(hook.result.current.files.sessionFailures.map((entry) => entry.path)).toEqual(
      ['a', 'b'].map(path),
    );
    expect(
      hook.result.current.files.sessionFailures.every((entry) =>
        entry.message.startsWith('Unavailable:'),
      ),
    ).toBe(true);
    expect(hook.result.current.session.tabs.map((item) => item.path)).toEqual([path('c')]);
    expect(hook.result.current.files.startupResolved).toBe(true);
    expect(mocks.message).not.toHaveBeenCalled();
  });
  it('reads current disk bodies in saved order and restores active tab/mode without touching drafts', async () => {
    const saved = snapshot('a', 'b', 'c');
    const oldBody = '# Old disk body\n\nSelected paragraph.\n';
    const place: SessionEditorPlace = {
      sourceMode: true,
      start: textAnchor(oldBody, 20),
      end: textAnchor(oldBody, 28),
      direction: 'backward',
      top: 345,
      left: 0,
    };
    saved.activePath = path('b');
    saved.documents[1].place = place;
    mocks.load.mockResolvedValue({ enabled: true, session: saved });
    file('a');
    file('b', '# Latest changed disk body\n\nSelected paragraph.\n');
    file('c');
    const hook = setup();
    await act(flush);
    expect(hook.result.current.session.tabs.map((item) => item.path)).toEqual(
      saved.documents.map((entry) => entry.path),
    );
    expect(hook.result.current.session.activeTab?.path).toBe(path('b'));
    expect(hook.result.current.session.sourceMode).toBe(true);
    expect(hook.result.current.session.activeTab?.markdown).toContain('Latest changed disk body');
    expect(hook.result.current.session.activeTab?.dirty).toBe(false);
    expect(hook.result.current.files.startupResolved).toBe(true);
    expect(hook.result.current.files.sessionRestoreBusy).toBe(false);
    expect(mocks.clean).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).not.toContain(
      'delete_recovery_snapshot',
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.read.mock.calls.map(([requested]) => requested)).toEqual([
      path('a'),
      path('b'),
      path('c'),
    ]);
  });

  it('reuses a restored startup path and appends a new requested file, preserving old order', async () => {
    const saved = snapshot('a', 'b', 'c');
    saved.activePath = path('a');
    mocks.load.mockResolvedValue({ enabled: true, session: saved });
    mocks.startup = [path('c'), path('d')];
    for (const name of ['a', 'b', 'c', 'd']) file(name);
    const hook = setup();
    await act(flush);
    expect(hook.result.current.session.tabs.map((item) => item.path)).toEqual(
      ['a', 'b', 'c', 'd'].map(path),
    );
    expect(hook.result.current.session.activeTab?.path).toBe(path('d'));
    expect(mocks.read.mock.calls.filter(([requested]) => requested === path('c'))).toHaveLength(1);
  });

  it('opens command-line files while session settings are still pending and does not overwrite an intervening edit', async () => {
    const gate = deferred<{ enabled: boolean; session: SavedDocumentSession }>();
    mocks.load.mockReturnValueOnce(gate.promise);
    mocks.startup = [path('b')];
    file('a');
    file('b');
    const hook = setup();
    await act(flush);
    expect(hook.result.current.session.activeTab?.path).toBe(path('b'));
    expect(hook.result.current.files.startupResolved).toBe(true);
    const id = hook.result.current.session.activeId!;
    act(() => {
      hook.result.current.session.contentGenerations.current[id] = 1;
      hook.result.current.session.updateTab(id, { markdown: 'Intervening user edit', dirty: true });
    });
    const saved = snapshot('a', 'b');
    const anchor = textAnchor('old body', 3);
    saved.documents[1].place = {
      sourceMode: true,
      start: anchor,
      end: anchor,
      direction: 'none',
      top: 5,
      left: 0,
    };
    await act(async () => {
      gate.resolve({ enabled: true, session: saved });
      await flush();
    });
    expect(hook.result.current.session.tabs.map((item) => item.path)).toEqual(['a', 'b'].map(path));
    expect(hook.result.current.session.activeTab?.markdown).toBe('Intervening user edit');
    expect(hook.result.current.session.sourceMode).toBe(false);
  });

  it('aggregates unavailable paths, retains their slots, and retries once while busy', async () => {
    const saved = snapshot('a', 'b', 'c');
    mocks.load.mockResolvedValue({ enabled: true, session: saved });
    file('c');
    const hook = setup();
    await act(flush);
    expect(hook.result.current.files.sessionFailures.map((entry) => entry.path)).toEqual(
      ['a', 'b'].map(path),
    );
    expect(hook.result.current.session.tabs.map((item) => item.path)).toEqual([path('c')]);
    expect(hook.result.current.files.startupResolved).toBe(true);
    expect(mocks.waitWindow).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(501));
    expect(
      mocks.persist.mock.calls.at(-1)?.[0].documents.map((entry: { path: string }) => entry.path),
    ).toEqual(['a', 'b', 'c'].map(path));
    const gate = deferred<void>();
    const originalRead = mocks.read.getMockImplementation()!;
    mocks.read.mockImplementation(async (requested: string) => {
      await gate.promise;
      return originalRead(requested);
    });
    file('a');
    file('b');
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.result.current.files.retrySessionFailures();
      second = hook.result.current.files.retrySessionFailures();
    });
    expect(first).toBe(second);
    await act(flush);
    expect(hook.result.current.files.sessionRestoreBusy).toBe(true);
    await act(async () => {
      gate.resolve();
      await first;
      await flush();
    });
    expect(hook.result.current.files.sessionFailures).toEqual([]);
    expect(hook.result.current.session.tabs.map((item) => item.path)).toEqual(
      ['a', 'b', 'c'].map(path),
    );
    expect(hook.result.current.session.activeTab?.path).toBe(path('c'));
  });

  it('keeps a failed settings read retryable and restores other files without replacing a live requested tab', async () => {
    mocks.load
      .mockRejectedValueOnce(new Error('settings unavailable'))
      .mockResolvedValue({ enabled: true, session: snapshot('a', 'b') });
    mocks.startup = [path('b'), path('d')];
    file('b');
    const hook = setup();
    await act(flush);
    expect(hook.result.current.files.sessionFailures).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(501));
    expect(mocks.persist).not.toHaveBeenCalled();
    file('a');
    file('d');
    await act(() => hook.result.current.files.retrySessionFailures());
    expect(hook.result.current.files.sessionFailures).toEqual([]);
    expect(hook.result.current.session.tabs.map((item) => item.path)).toEqual(
      ['a', 'b', 'd'].map(path),
    );
    expect(mocks.read.mock.calls.filter(([requested]) => requested === path('b'))).toHaveLength(1);
  });

  it('honors the off preference while still opening this launch request', async () => {
    mocks.load.mockResolvedValue({ enabled: false, session: snapshot('a') });
    mocks.startup = [path('b')];
    file('a');
    file('b');
    const hook = setup();
    await act(flush);
    expect(hook.result.current.files.sessionRestoreEnabled).toBe(false);
    expect(hook.result.current.session.tabs.map((item) => item.path)).toEqual([path('b')]);
    await act(() => vi.advanceTimersByTimeAsync(501));
    expect(mocks.persist).not.toHaveBeenCalled();
    await act(() => hook.result.current.files.changeSessionRestore(true));
    expect(mocks.enabled).toHaveBeenCalledWith(true);
    expect(hook.result.current.files.sessionRestoreEnabled).toBe(true);
  });

  it('respects the latest active tab when the user switches during a delayed retry', async () => {
    mocks.load.mockResolvedValue({ enabled: true, session: snapshot('a', 'b', 'c') });
    file('a');
    file('c');
    const hook = setup();
    await act(flush);
    const gate = deferred<void>();
    const originalRead = mocks.read.getMockImplementation()!;
    mocks.read.mockImplementation(async (requested: string) => {
      await gate.promise;
      return originalRead(requested);
    });
    file('b');
    let retry!: Promise<void>;
    act(() => {
      retry = hook.result.current.files.retrySessionFailures();
    });
    await act(flush);
    act(() =>
      hook.result.current.session.selectTab(
        hook.result.current.session.tabsRef.current.find((item) => item.path === path('c'))!.id,
      ),
    );
    await act(async () => {
      gate.resolve();
      await retry;
      await flush();
    });
    expect(hook.result.current.session.activeTab?.path).toBe(path('c'));
    expect(hook.result.current.files.sessionFailures).toEqual([]);
  });

  it('rejects a failed preference write and restores the visible switch', async () => {
    mocks.enabled.mockRejectedValueOnce(new Error('preferences disk full'));
    const hook = setup();
    await act(flush);
    await act(async () => {
      await expect(hook.result.current.files.changeSessionRestore(false)).rejects.toThrow(
        'preferences disk full',
      );
    });
    expect(hook.result.current.files.sessionRestoreEnabled).toBe(true);
  });
});

describe('window-close session transaction', () => {
  it('preserves old paths discovered by a successful close-time reread after the first session read failed', async () => {
    mocks.load
      .mockRejectedValueOnce(new Error('first session read unavailable'))
      .mockResolvedValue({ enabled: true, session: snapshot('a', 'b') });
    mocks.startup = [path('c')];
    file('c');
    const hook = setup();
    await act(flush);
    expect(hook.result.current.session.tabs.map((item) => item.path)).toEqual([path('c')]);
    await act(async () => {
      hook.result.current.close.handleWindowClose();
      await flush();
    });
    const committed = mocks.persist.mock.calls.at(-1)?.[0] as SavedDocumentSession;
    expect(committed.documents.map((entry) => entry.path)).toEqual(['a', 'b', 'c'].map(path));
    expect(committed.activePath).toBe(path('c'));
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.read.mock.calls.map(([requested]) => requested)).toEqual([path('c')]);
  });

  it('excludes a separately closed path when previously unread session metadata becomes available during exit', async () => {
    mocks.load
      .mockRejectedValueOnce(new Error('first session read unavailable'))
      .mockResolvedValue({ enabled: true, session: snapshot('a', 'b') });
    mocks.startup = [path('c')];
    file('a');
    file('c');
    const hook = setup();
    await act(flush);
    await act(() => hook.result.current.files.openFileFromPath(path('a')));
    await act(async () => {
      const id = hook.result.current.session.tabsRef.current.find(
        (item) => item.path === path('a'),
      )!.id;
      hook.result.current.close.closeTabRequest(id);
      await flush();
    });
    await act(async () => {
      hook.result.current.close.handleWindowClose();
      await flush();
    });
    expect(
      mocks.persist.mock.calls.at(-1)?.[0].documents.map((entry: { path: string }) => entry.path),
    ).toEqual(['b', 'c'].map(path));
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it('waits for pending startup restoration and commits the completed saved order when closing an early launch file', async () => {
    const gate = deferred<{ enabled: boolean; session: SavedDocumentSession }>();
    mocks.load.mockReturnValueOnce(gate.promise);
    mocks.startup = [path('b')];
    file('a');
    file('b');
    const hook = setup([], true);
    await act(flush);
    expect(hook.result.current.session.activeTab?.path).toBe(path('b'));
    await act(async () => {
      hook.result.current.close.handleWindowClose();
      await flush();
    });
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve({ enabled: true, session: snapshot('a', 'b') });
      await flush();
    });
    expect(
      mocks.persist.mock.calls.at(-1)?.[0].documents.map((entry: { path: string }) => entry.path),
    ).toEqual(['a', 'b'].map(path));
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it('captures removed tabs and live source position, and adopts the path of a new document saved during exit', async () => {
    const initial = [tab('a', true), tab('b'), tab('new', true, false)];
    const hook = setup(initial);
    await act(flush);
    const input = document.createElement('textarea');
    input.value = initial[0].markdown;
    document.body.append(input);
    input.setSelectionRange(2, 8, 'backward');
    input.scrollTop = 234;
    act(() => {
      hook.result.current.session.registerSource('a', input);
      hook.result.current.session.setSourceMode(true);
    });
    mocks.save.mockImplementation(async (id: string) => {
      const current = hook.result.current.session.tabsRef.current.find((item) => item.id === id)!;
      hook.result.current.session.updateTab(id, {
        path: path('saved-new'),
        isNew: false,
        dirty: false,
        savedContent: current.markdown,
      });
      return true;
    });
    await act(async () => {
      hook.result.current.close.handleWindowClose();
      await flush();
    });
    expect(hook.result.current.close.pendingCloseTab?.id).toBe('a');
    await act(() => hook.result.current.close.confirmClose('discard'));
    expect(hook.result.current.close.pendingCloseTab?.id).toBe('new');
    expect(hook.result.current.session.positions.current.a).toBeUndefined();
    await act(() => hook.result.current.close.confirmClose('save'));
    const committed = mocks.persist.mock.calls.at(-1)?.[0] as SavedDocumentSession;
    expect(committed.documents.map((entry) => entry.path)).toEqual([
      path('a'),
      path('b'),
      path('saved-new'),
    ]);
    expect(committed.activePath).toBe(path('a'));
    expect(committed.documents[0].place).toMatchObject({
      sourceMode: true,
      direction: 'backward',
      top: 234,
      start: { offset: 2 },
      end: { offset: 8 },
    });
    expect(mocks.destroy).toHaveBeenCalledOnce();
    input.remove();
  });

  it('flushes a departed source snapshot during immediate exit before the persistence timer runs', async () => {
    const initial = [tab('a'), tab('b')];
    const hook = setup(initial);
    await act(flush);
    const input = document.createElement('textarea');
    input.value = initial[0].markdown;
    document.body.append(input);
    input.setSelectionRange(2, 8, 'backward');
    input.scrollTop = 234;
    act(() => {
      hook.result.current.session.registerSource('a', input);
      hook.result.current.session.setSourceMode(true);
    });
    act(() => hook.result.current.session.selectTab('b'));
    expect(hook.result.current.session.positions.current.a.sessionCapture).toBeTypeOf('function');
    input.value = 'Another source value';
    input.setSelectionRange(0, 0);
    input.scrollTop = 0;
    expect(mocks.persist).not.toHaveBeenCalled();
    await act(async () => {
      hook.result.current.close.handleWindowClose();
      await flush();
    });
    const committed = mocks.persist.mock.calls.at(-1)?.[0] as SavedDocumentSession;
    expect(committed.activePath).toBe(path('b'));
    expect(committed.documents[0].place).toMatchObject({
      sourceMode: true,
      direction: 'backward',
      top: 234,
      start: { offset: 2 },
      end: { offset: 8 },
    });
    expect(hook.result.current.session.positions.current.a.sessionCapture).toBeUndefined();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    input.remove();
  });

  it('keeps the full durable session when the second confirmation cancels an exit', async () => {
    const hook = setup([tab('a', true), tab('b', true)]);
    await act(flush);
    await act(() => vi.advanceTimersByTimeAsync(501));
    expect(mocks.persist).toHaveBeenCalledOnce();
    await act(async () => {
      hook.result.current.close.handleWindowClose();
      await flush();
    });
    await act(() => hook.result.current.close.confirmClose('discard'));
    expect(hook.result.current.close.pendingCloseTab?.id).toBe('b');
    await act(() => hook.result.current.close.confirmClose('cancel'));
    await act(() => vi.advanceTimersByTimeAsync(501));
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(
      mocks.persist.mock.calls[0][0].documents.map((entry: { path: string }) => entry.path),
    ).toEqual(['a', 'b'].map(path));
    expect(hook.result.current.session.tabs.map((item) => item.id)).toEqual(['b']);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it('does not commit partial state when cleanup or saving fails during exit', async () => {
    const hook = setup([tab('a', true), tab('b')]);
    await act(flush);
    await act(() => vi.advanceTimersByTimeAsync(501));
    mocks.clean.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await act(async () => {
      hook.result.current.close.handleWindowClose();
      await flush();
    });
    await act(() => hook.result.current.close.confirmClose('discard'));
    await act(() => vi.advanceTimersByTimeAsync(501));
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(mocks.message).toHaveBeenCalled();
  });

  it('retains the captured complete list even if native destruction fails after committing', async () => {
    mocks.destroy.mockRejectedValueOnce(new Error('native destruction failed'));
    const hook = setup([tab('a', true), tab('b')]);
    await act(flush);
    await act(async () => {
      hook.result.current.close.handleWindowClose();
      await flush();
    });
    await act(() => hook.result.current.close.confirmClose('discard'));
    await act(() => vi.advanceTimersByTimeAsync(501));
    expect(
      mocks.persist.mock.calls.at(-1)?.[0].documents.map((entry: { path: string }) => entry.path),
    ).toEqual(['a', 'b'].map(path));
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.message).toHaveBeenCalled();
  });

  it('omits an explicitly closed tab and a discarded untitled draft from the next session', async () => {
    const hook = setup([tab('a'), tab('b'), tab('untitled', true, false)]);
    await act(flush);
    await act(async () => {
      hook.result.current.close.closeTabRequest('a');
      await flush();
    });
    act(() => hook.result.current.close.closeTabRequest('untitled'));
    await act(() => hook.result.current.close.confirmClose('discard'));
    await act(() => vi.advanceTimersByTimeAsync(501));
    expect(
      mocks.persist.mock.calls.at(-1)?.[0].documents.map((entry: { path: string }) => entry.path),
    ).toEqual([path('b')]);
    expect(mocks.clean.mock.calls.map(([id]) => id)).toEqual(['a', 'untitled']);
  });
});
