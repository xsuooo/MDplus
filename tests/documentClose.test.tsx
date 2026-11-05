// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentSession } from '../src/hooks/useDocumentSession';
import { useDocumentClose } from '../src/hooks/useDocumentClose';
import type { Tab } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  clean: vi.fn(),
  protect: vi.fn(),
  persist: vi.fn(),
  destroy: vi.fn(),
  message: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ destroy: mocks.destroy }) }));
vi.mock('../src/lib/dialog', () => ({ showMessage: mocks.message }));
vi.mock('../src/lib/editor', () => ({ setMarkdown: vi.fn() }));
vi.mock('../src/lib/imageOps', () => ({ clearPendingImages: vi.fn() }));
const initial = (dirty = true): Tab => ({
  id: 'a',
  title: 'a.md',
  path: 'C:/a.md',
  isNew: false,
  dirty,
  markdown: 'draft',
  savedContent: 'old',
  initialContent: 'old',
  externalMtime: 1,
  diskRevision: 'old',
  externalChanged: false,
  stats: { words: 1, chars: 5, lines: 1 },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const onClosing = () => {};
function setup(dirty = true) {
  return renderHook(() => {
    const session = useDocumentSession([initial(dirty)]);
    const close = useDocumentClose(
      session,
      { cleanRecovery: mocks.clean, protectDraft: mocks.protect },
      mocks.save,
      mocks.persist,
      onClosing,
    );
    return { session, close };
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.save.mockResolvedValue(true);
  mocks.clean.mockResolvedValue(true);
  mocks.persist.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.message.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('close exception and cancellation boundaries', () => {
  it('retains the confirmation and draft when the save operation unexpectedly rejects', async () => {
    mocks.save.mockRejectedValueOnce(new Error('unexpected save failure'));
    const hook = setup();
    act(() => hook.result.current.close.closeTabRequest('a'));
    await act(async () => {
      await expect(hook.result.current.close.confirmClose('save')).resolves.toBeUndefined();
    });
    expect(hook.result.current.session.tabsRef.current).toHaveLength(1);
    expect(hook.result.current.close.pendingCloseTab?.id).toBe('a');
    expect(hook.result.current.close.closeBusy).toBe(false);
    expect(mocks.message).toHaveBeenCalled();
    expect(mocks.protect).toHaveBeenCalled();
  });

  it('keeps a failed cleanup retryable without removing the tab', async () => {
    mocks.clean.mockResolvedValueOnce(false);
    const hook = setup();
    act(() => hook.result.current.close.closeTabRequest('a'));
    await act(() => hook.result.current.close.confirmClose('discard'));
    expect(hook.result.current.session.tabsRef.current).toHaveLength(1);
    expect(hook.result.current.close.closeBusy).toBe(false);
    await act(() => hook.result.current.close.confirmClose('discard'));
    expect(hook.result.current.session.tabsRef.current).toHaveLength(0);
  });

  it('cancels an awaiting save continuation while allowing the save to finish', async () => {
    const gate = deferred<boolean>();
    mocks.save.mockReturnValueOnce(gate.promise);
    const hook = setup();
    act(() => hook.result.current.close.closeTabRequest('a'));
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.close.confirmClose('save');
    });
    await act(() => hook.result.current.close.confirmClose('cancel'));
    await act(async () => {
      hook.result.current.session.updateTab('a', { dirty: false });
      gate.resolve(true);
      await saving;
    });
    expect(hook.result.current.session.tabsRef.current).toHaveLength(1);
    expect(hook.result.current.close.pendingCloseTab).toBeNull();
  });

  it('rechecks new edits after persisting the last clean window state', async () => {
    const gate = deferred<void>();
    mocks.persist.mockReturnValueOnce(gate.promise);
    const hook = setup(false);
    await act(async () => hook.result.current.close.handleWindowClose());
    await act(async () => {
      hook.result.current.session.updateTab('a', { dirty: true, markdown: 'latest' });
      gate.resolve();
    });
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(hook.result.current.close.pendingCloseTab?.markdown).toBe('latest');
  });

  it('allows a fresh close request after native destruction fails', async () => {
    mocks.destroy.mockRejectedValueOnce(new Error('native close failed'));
    const hook = setup(false);
    await act(async () => hook.result.current.close.handleWindowClose());
    expect(hook.result.current.session.tabsRef.current).toHaveLength(1);
    await act(async () => hook.result.current.close.handleWindowClose());
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });
});
