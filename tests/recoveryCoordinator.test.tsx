// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryModal } from '../src/components/RecoveryModal';
import { useWorkspace } from '../src/hooks/useWorkspace';
import { useRecovery } from '../src/hooks/useRecovery';
import { Presence } from '../src/lib/presence';
import { deleteSnapshot } from '../src/lib/recovery';

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
    const workspace = useWorkspace();
    const recovery = useRecovery(workspace);
    return { workspace, recovery };
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
  it.each([
    ['recovered.md', 'recovered (恢复).md'],
    ['recovered (恢复).md', 'recovered (恢复).md'],
    ['recovered (恢复) (恢复).MD', 'recovered (恢复).md'],
    ['2026 (恢复) notes.md', '2026 (恢复) notes (恢复).md'],
  ])('marks recovery once for %s', async (title, expected) => {
    mocks.restore.mockImplementation(async (id: string) => {
      const copy = restored(id);
      return { ...copy, snapshot: { ...copy.snapshot, title } };
    });
    const hook = setup();
    await act(async () => {
      await hook.result.current.recovery.handleRestore('title-check');
    });
    const tab = hook.result.current.workspace.tabs.find((entry) => entry.id === 'title-check');
    expect(tab).toMatchObject({ id: 'title-check', title: expected, path: null, isNew: true });
    expect(hook.result.current.workspace.resolveContent(tab!)).toBe('original');
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    expect(mocks.installImages).toHaveBeenCalledTimes(1);
  });
  it('preserves a recovery suffix belonging to an original file', async () => {
    mocks.restore.mockImplementation(async (id: string) => {
      const copy = restored(id);
      return {
        ...copy,
        snapshot: {
          ...copy.snapshot,
          title: 'saved (恢复).md',
          originalPath: 'C:\\notes\\saved (恢复).md',
        },
      };
    });
    const hook = setup();
    await act(async () => {
      await hook.result.current.recovery.handleRestore('saved-name');
    });
    const tab = hook.result.current.workspace.tabs.find((entry) => entry.id === 'saved-name');
    expect(tab).toMatchObject({ title: 'saved (恢复) (恢复).md', path: null, isNew: true });
    expect(hook.result.current.workspace.resolveContent(tab!)).toBe('original');
  });
  it('shows a cleanup warning while keeping an intact recovery available', () => {
    const entries = [
      {
        id: 'locked',
        title: 'intact draft',
        originalPath: null,
        updatedAt: 1,
        damaged: false,
        cleanupError: 'file is locked',
      },
    ];
    render(
      <RecoveryModal
        entries={entries}
        onRestore={async () => {}}
        onRemove={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('自动清理');
    expect(screen.getByText('intact draft')).toBeTruthy();
    expect((screen.getByRole('button', { name: '恢复副本' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

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
    expect(hook.result.current.workspace.tabsRef.current.map((tab) => tab.id)).toEqual(['shared']);
    expect(mocks.installImages).toHaveBeenCalledTimes(1);
  });

  it('remains idempotent when Escape unmounts the busy modal and the user opens it again', async () => {
    const gate = deferred<ReturnType<typeof restored>>();
    mocks.restore.mockReturnValue(gate.promise);
    function Harness() {
      const workspace = useWorkspace();
      const recovery = useRecovery(workspace);
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
          <output data-testid="tab-ids">{workspace.tabs.map((tab) => tab.id).join(',')}</output>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '恢复管理' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复副本' }));
    expect((screen.getByRole('button', { name: '恢复中…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(screen.getByRole('dialog')).getByRole('status').textContent).toContain(
      '正在恢复「recovered」为新副本',
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
      hook.result.current.workspace.addTab(
        { title: 'newer', path: null, isNew: true, content: 'newer content' },
        'taken',
      );
      hook.result.current.workspace.runtimeOf('taken').contentVersion = 7;
    });
    await act(async () => {
      gate.resolve(restored('taken'));
      await operation;
    });
    expect(hook.result.current.workspace.tabsRef.current).toHaveLength(1);
    expect(hook.result.current.workspace.tabsRef.current[0].markdown).toBe('newer content');
    expect(hook.result.current.workspace.tabRuntime.current['taken']?.contentVersion).toBe(7);
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
      await deleteSnapshot('deleted');
      gate.resolve(restored('deleted'));
      await operation;
    });
    expect(hook.result.current.workspace.tabsRef.current).toHaveLength(0);
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
    expect(hook.result.current.workspace.tabsRef.current.map((tab) => tab.id)).toEqual(['retry']);
  });

  it('does not reset a live tab when addTab is called again with its id', () => {
    const hook = setup();
    act(() => {
      hook.result.current.workspace.addTab(
        { title: 'first', path: null, isNew: true, content: 'keep me' },
        'unique',
      );
      hook.result.current.workspace.runtimeOf('unique').contentVersion = 9;
      hook.result.current.workspace.addTab(
        { title: 'second', path: null, isNew: true, content: 'do not replace' },
        'unique',
      );
    });
    expect(hook.result.current.workspace.tabsRef.current).toHaveLength(1);
    expect(hook.result.current.workspace.tabsRef.current[0].markdown).toBe('keep me');
    expect(hook.result.current.workspace.tabRuntime.current['unique']?.contentVersion).toBe(9);
  });
});
