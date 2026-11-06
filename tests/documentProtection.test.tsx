// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_POLL_MS } from '../src/config/constants';
import { useDocumentSession } from '../src/hooks/useDocumentSession';
import { useDocumentClose } from '../src/hooks/useDocumentClose';
import { useExternalChanges } from '../src/hooks/useExternalChanges';
import { useRecovery } from '../src/hooks/useRecovery';
import type { Tab } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  revision: vi.fn(),
  read: vi.fn(),
  confirm: vi.fn(),
  message: vi.fn(),
  clear: vi.fn(),
  schedule: vi.fn(),
  save: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ destroy: mocks.destroy }) }));
vi.mock('../src/lib/dialog', () => ({
  showMessage: mocks.message,
  confirmDialog: mocks.confirm,
}));
vi.mock('../src/lib/fileOps', () => ({
  documentRevision: mocks.revision,
  readDocument: mocks.read,
  basename: (path: string) => path.split(/[\\/]/).at(-1) ?? path,
}));
vi.mock('../src/lib/editor', () => ({ setMarkdown: vi.fn() }));
vi.mock('../src/lib/imageOps', () => ({
  clearPendingImages: vi.fn(),
  prepareImageReferences: vi.fn(async () => ({ commit: () => true, dispose: async () => {} })),
}));
vi.mock('../src/lib/recovery', () => ({
  clearRecovery: mocks.clear,
  scheduleRecovery: mocks.schedule,
  listRecovery: vi.fn(async () => []),
  restoreRecovery: vi.fn(),
  prepareRecovery: vi.fn(),
}));

const initial = (): Tab => ({
  id: 'a',
  title: 'a.md',
  path: 'C:/notes/a.md',
  isNew: false,
  dirty: false,
  markdown: 'local original A',
  savedContent: 'local original A',
  initialContent: 'local original A',
  externalMtime: 1,
  diskRevision: 'A',
  externalChanged: false,
  stats: { words: 3, chars: 14, lines: 1 },
});
const persist = async () => {};
const onClosing = () => {};
function setup() {
  return renderHook(() => {
    const session = useDocumentSession([initial()]);
    const recovery = useRecovery(session);
    useExternalChanges(session, recovery);
    const close = useDocumentClose(session, recovery, mocks.save, persist, onClosing);
    return { session, recovery, close };
  });
}
async function poll() {
  await act(() => vi.advanceTimersByTimeAsync(EXTERNAL_POLL_MS));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.revision.mockResolvedValue({ path: 'C:/notes/a.md', revision: 'B', mtime: 2 });
  mocks.read.mockResolvedValue({
    path: 'C:/notes/a.md',
    content: 'external B',
    revision: 'B',
    mtime: 2,
  });
  mocks.confirm.mockResolvedValue(false);
  mocks.message.mockResolvedValue(undefined);
  mocks.clear.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(true);
  mocks.destroy.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('local versions without a matching disk copy', () => {
  it('protects a declined external version and confirms before closing its clean buffer', async () => {
    const hook = setup();
    await poll();
    expect(hook.result.current.session.tabsRef.current[0].markdown).toBe('local original A');
    // A disk divergence is not a new keystroke: keep polling for later disk versions.
    expect(hook.result.current.session.tabsRef.current[0].dirty).toBe(false);
    expect(mocks.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', markdown: 'local original A' }),
      expect.any(Function),
      expect.any(Promise),
    );
    act(() => hook.result.current.close.closeTabRequest('a'));
    expect(hook.result.current.close.pendingCloseTab?.id).toBe('a');
    expect(hook.result.current.session.tabsRef.current).toHaveLength(1);
    expect(mocks.clear).not.toHaveBeenCalled();
    await act(() => hook.result.current.close.confirmClose('cancel'));
    expect(hook.result.current.session.tabsRef.current).toHaveLength(1);
  });

  it('does not destroy the window or delete recovery after declining an external version', async () => {
    const hook = setup();
    await poll();
    await act(async () => hook.result.current.close.handleWindowClose());
    expect(hook.result.current.close.pendingCloseTab?.id).toBe('a');
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('also preserves a clean buffer whose disk file has disappeared', async () => {
    mocks.revision.mockResolvedValue({ path: 'C:/notes/a.md', revision: null, mtime: null });
    const hook = setup();
    await poll();
    act(() => hook.result.current.close.closeTabRequest('a'));
    expect(hook.result.current.close.pendingCloseTab?.id).toBe('a');
    expect(mocks.schedule).toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('still notices later disk revisions after the first reload was declined', async () => {
    const hook = setup();
    await poll();
    mocks.revision.mockResolvedValue({ path: 'C:/notes/a.md', revision: 'C', mtime: 2 });
    await poll();
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(hook.result.current.session.tabsRef.current[0].markdown).toBe('local original A');
  });

  it('clears local-only protection after an accepted and verified reload', async () => {
    const hook = setup();
    await poll();
    mocks.confirm.mockResolvedValue(true);
    mocks.revision.mockResolvedValue({ path: 'C:/notes/a.md', revision: 'C', mtime: 3 });
    mocks.read.mockResolvedValue({
      path: 'C:/notes/a.md',
      content: 'external C',
      revision: 'C',
      mtime: 3,
    });
    await poll();
    expect(hook.result.current.session.tabsRef.current[0].markdown).toBe('external C');
    await act(async () => hook.result.current.close.closeTabRequest('a'));
    expect(hook.result.current.session.tabsRef.current).toHaveLength(0);
    expect(hook.result.current.close.pendingCloseTab).toBeNull();
  });

  it('rechecks disk-only protection that appears while clean-close cleanup is pending', async () => {
    let release!: () => void;
    mocks.clear.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
    const hook = setup();
    act(() => hook.result.current.close.closeTabRequest('a'));
    act(() => hook.result.current.session.pauseAutoSave('a', -1));
    await act(async () => release());
    expect(hook.result.current.session.tabsRef.current).toHaveLength(1);
    expect(hook.result.current.close.pendingCloseTab?.id).toBe('a');
  });

  it('allows an explicit discard of the retained version', async () => {
    const hook = setup();
    await poll();
    act(() => hook.result.current.close.closeTabRequest('a'));
    await act(() => hook.result.current.close.confirmClose('discard'));
    expect(hook.result.current.session.tabsRef.current).toHaveLength(0);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });
});
