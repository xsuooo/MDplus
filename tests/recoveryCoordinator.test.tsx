// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryModal } from '../src/components/RecoveryModal';
import { useDocumentSession } from '../src/hooks/useDocumentSession';
import { useRecovery } from '../src/hooks/useRecovery';
import { Presence } from '../src/lib/presence';
import { clearRecovery } from '../src/lib/recovery';

const mocks = vi.hoisted(() => ({
  restore: vi.fn(),
  installImages: vi.fn(),
  clearImages: vi.fn(),
  message: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: (command: string, args?: { id?: string }) => {
    if (command === 'read_recovery_snapshot') return mocks.restore(args?.id);
    if (command === 'list_recovery_snapshots') return Promise.resolve([]);
    if (command === 'delete_recovery_snapshot') return Promise.resolve();
    return Promise.reject(new Error(`Unexpected IPC: ${command}`));
  },
}));
vi.mock('../src/lib/dialog', () => ({ showMessage: mocks.message, confirmDialog: vi.fn() }));
vi.mock('../src/lib/editor', () => ({ setMarkdown: vi.fn() }));
vi.mock('../src/lib/imageOps', () => ({
  clearPendingImages: mocks.clearImages,
  restorePendingImages: mocks.installImages,
  stagePendingImages: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })),
  getPendingImages: () => [],
  capturePendingImages: () => ({ images: [], release: vi.fn(), withDataBase64: vi.fn() }),
  prepareImageReferences: vi.fn(async () => ({ commit: () => true, dispose: async () => {} })),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function restored(id: string) {
  return {
    snapshot: { id, title: 'recovered.md', originalPath: null, markdown: 'original', images: [] },
    images: [],
  };
}
function setup() {
  return renderHook(() => {
    const session = useDocumentSession();
    const recovery = useRecovery(session);
    return { session, recovery };
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.restore.mockImplementation(async (id: string) => restored(id));
  mocks.message.mockResolvedValue(undefined);
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('recovery identity and publication', () => {
  it('shares an in-flight restore instead of adding a duplicate id or installing images twice', async () => {
    const gate = deferred<ReturnType<typeof restored>>();
    mocks.restore.mockReturnValue(gate.promise);
    const hook = setup();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.result.current.recovery.handleRestore('shared');
      second = hook.result.current.recovery.handleRestore('shared');
    });
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(restored('shared'));
      await Promise.all([first, second]);
    });
    expect(hook.result.current.session.tabsRef.current.map((tab) => tab.id)).toEqual(['shared']);
    expect(mocks.installImages).toHaveBeenCalledTimes(1);
  });

  it('remains idempotent when Escape unmounts the busy modal and the user opens it again', async () => {
    const gate = deferred<ReturnType<typeof restored>>();
    mocks.restore.mockReturnValue(gate.promise);
    function Harness() {
      const session = useDocumentSession();
      const recovery = useRecovery(session);
      return (
        <>
          <button onClick={() => recovery.setRecoveryOpen(true)}>恢复管理</button>
          <Presence present={recovery.recoveryOpen}>
            <RecoveryModal
              entries={[
                {
                  id: 'modal',
                  title: 'recovered',
                  originalPath: null,
                  updatedAt: 1,
                  damaged: false,
                },
              ]}
              onRestore={recovery.handleRestore}
              onRemove={recovery.handleRecoveryRemoved}
              onClose={() => recovery.setRecoveryOpen(false)}
            />
          </Presence>
          <output data-testid="tab-ids">{session.tabs.map((tab) => tab.id).join(',')}</output>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '恢复管理' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复副本' }));
    expect((screen.getByRole('button', { name: '恢复副本' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '恢复管理' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复副本' }));
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve(restored('modal')));
    expect(screen.getByTestId('tab-ids').textContent).toBe('modal');
    expect(mocks.installImages).toHaveBeenCalledTimes(1);
  });

  it('does not replace an already-created tab or its image cache after a delayed response', async () => {
    const gate = deferred<ReturnType<typeof restored>>();
    mocks.restore.mockReturnValueOnce(gate.promise);
    const hook = setup();
    let operation!: Promise<void>;
    act(() => {
      operation = hook.result.current.recovery.handleRestore('taken');
      hook.result.current.session.addTab(
        { title: 'newer', path: null, isNew: true, content: 'newer content' },
        'taken',
      );
      hook.result.current.session.contentGenerations.current.taken = 7;
    });
    await act(async () => {
      gate.resolve(restored('taken'));
      await operation;
    });
    expect(hook.result.current.session.tabsRef.current).toHaveLength(1);
    expect(hook.result.current.session.tabsRef.current[0].markdown).toBe('newer content');
    expect(hook.result.current.session.contentGenerations.current.taken).toBe(7);
    expect(mocks.installImages).not.toHaveBeenCalled();
  });

  it('does not resurrect a recovery entry deleted during its read', async () => {
    const gate = deferred<ReturnType<typeof restored>>();
    mocks.restore.mockReturnValueOnce(gate.promise);
    const hook = setup();
    let operation!: Promise<void>;
    act(() => {
      operation = hook.result.current.recovery.handleRestore('deleted');
    });
    await act(async () => {
      await clearRecovery('deleted');
      gate.resolve(restored('deleted'));
      await operation;
    });
    expect(hook.result.current.session.tabsRef.current).toHaveLength(0);
    expect(mocks.installImages).not.toHaveBeenCalled();
  });

  it('does not publish a response after the owning session unmounts', async () => {
    const gate = deferred<ReturnType<typeof restored>>();
    mocks.restore.mockReturnValueOnce(gate.promise);
    const hook = setup();
    const operation = hook.result.current.recovery.handleRestore('unmounted');
    hook.unmount();
    await act(async () => {
      gate.resolve(restored('unmounted'));
      await operation;
    });
    expect(mocks.installImages).not.toHaveBeenCalled();
  });

  it('releases the in-flight entry after failure so a later restore can retry', async () => {
    mocks.restore.mockRejectedValueOnce(new Error('temporary read failure'));
    const hook = setup();
    await act(async () => {
      await expect(hook.result.current.recovery.handleRestore('retry')).rejects.toThrow(
        'temporary read failure',
      );
    });
    await act(() => hook.result.current.recovery.handleRestore('retry'));
    expect(mocks.restore).toHaveBeenCalledTimes(2);
    expect(hook.result.current.session.tabsRef.current.map((tab) => tab.id)).toEqual(['retry']);
  });

  it('does not reset a live tab when addTab is called again with its id', () => {
    const hook = setup();
    act(() => {
      hook.result.current.session.addTab(
        { title: 'first', path: null, isNew: true, content: 'keep me' },
        'unique',
      );
      hook.result.current.session.contentGenerations.current.unique = 9;
      hook.result.current.session.addTab(
        { title: 'second', path: null, isNew: true, content: 'do not replace' },
        'unique',
      );
    });
    expect(hook.result.current.session.tabsRef.current).toHaveLength(1);
    expect(hook.result.current.session.tabsRef.current[0].markdown).toBe('keep me');
    expect(hook.result.current.session.contentGenerations.current.unique).toBe(9);
  });
});
