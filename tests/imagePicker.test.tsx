// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentSession } from '../src/hooks/useDocumentSession';
import { useImageDrop } from '../src/hooks/useImageDrop';
import type { SourceEditorApi } from '../src/lib/sourceEditorApi';

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  import: vi.fn(),
  cancel: vi.fn(),
  protect: vi.fn(),
}));
vi.mock('../src/lib/fileOps', async (original) => ({
  ...(await original<typeof import('../src/lib/fileOps')>()),
  pickImageFiles: mocks.pick,
}));
vi.mock('../src/lib/imageOps', () => ({
  importDroppedImage: mocks.import,
  cancelImageInsertion: mocks.cancel,
  settleImageInsertion: vi.fn(),
  clearPendingImages: vi.fn(),
}));
vi.mock('../src/lib/recovery', () => ({ protectPastedImage: mocks.protect }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const input = document.createElement('textarea');
  input.value = 'before TARGET after';
  input.setSelectionRange(7, 13);
  document.body.append(input);
  const api: SourceEditorApi = {
    read: () => ({ text: input.value, start: input.selectionStart, end: input.selectionEnd }),
    applyEdits: (edits, selection) => {
      for (const edit of [...edits].reverse())
        input.value = input.value.slice(0, edit.from) + edit.text + input.value.slice(edit.to);
      if (selection) input.setSelectionRange(selection.start, selection.end);
      return true;
    },
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const hook = renderHook(() => {
    const session = useDocumentSession();
    const images = useImageDrop(session, (id) => (id === 'a' ? api : null));
    return { session, images };
  });
  act(() => {
    hook.result.current.session.addTab(
      { title: 'a.md', path: null, isNew: true, content: input.value },
      'a',
    );
    hook.result.current.session.registerSource('a', input);
    hook.result.current.session.setSourceMode(true);
  });
  return { hook, input };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.pick.mockResolvedValue(['C:/images/10.png', 'C:/images/2.jpg']);
  mocks.import.mockImplementation(
    async (path: string) => `mdplus-image:${path.endsWith('10.png') ? 'ten' : 'two'}`,
  );
  mocks.protect.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  document.querySelectorAll('textarea').forEach((input) => input.remove());
});

describe('image selection lifecycle', () => {
  it('shows completed/total progress during native work and clears it only after batch insertion', async () => {
    const { hook, input } = setup();
    const first = deferred<string>();
    const second = deferred<string>();
    mocks.import.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let operation!: ReturnType<typeof hook.result.current.images.pick>;
    await act(async () => {
      operation = hook.result.current.images.pick();
      await Promise.resolve();
    });
    expect(hook.result.current.images.progress).toEqual({ completed: 0, total: 2 });
    expect(input.value).toBe('before TARGET after');
    await act(async () => {
      first.resolve('mdplus-image:two');
      await vi.waitFor(() => expect(mocks.import).toHaveBeenCalledTimes(2));
    });
    expect(hook.result.current.images.progress).toEqual({ completed: 1, total: 2 });
    expect(input.value).toBe('before TARGET after');
    await act(async () => {
      second.resolve('mdplus-image:ten');
      expect((await operation)?.inserted).toBe(2);
    });
    expect(hook.result.current.images.progress).toBeNull();
    expect(hook.result.current.images.picking).toBe(false);
    expect(input.value).toContain('![](mdplus-image:two)\n![](mdplus-image:ten)');
  });

  it('inserts at the captured selection end, preserving text and natural file order', async () => {
    const { hook, input } = setup();
    const gate = deferred<string[]>();
    mocks.pick.mockReturnValue(gate.promise);
    let operation!: ReturnType<typeof hook.result.current.images.pick>;
    act(() => {
      operation = hook.result.current.images.pick();
    });
    input.setSelectionRange(0, 0);
    await act(async () => {
      gate.resolve(['C:/images/10.png', 'C:/images/2.jpg']);
      await operation;
    });
    expect(input.value).toBe('before TARGET![](mdplus-image:two)\n![](mdplus-image:ten) after');
    expect(mocks.import.mock.calls.map(([path]) => path)).toEqual([
      'C:/images/2.jpg',
      'C:/images/10.png',
    ]);
  });

  it('cancels when the native chooser is dismissed and permits another selection', async () => {
    const { hook, input } = setup();
    mocks.pick.mockResolvedValueOnce([]);
    await act(async () => {
      expect(await hook.result.current.images.pick()).toBeNull();
    });
    expect(mocks.import).not.toHaveBeenCalled();
    expect(input.value).toBe('before TARGET after');
    await act(async () => {
      expect((await hook.result.current.images.pick())?.inserted).toBe(2);
    });
  });

  it('reports chooser errors without inventing an image failure and permits another selection', async () => {
    const { hook, input } = setup();
    const error = new Error('native chooser unavailable');
    mocks.pick.mockRejectedValueOnce(error);
    await act(async () => {
      await expect(hook.result.current.images.pick()).rejects.toBe(error);
    });
    expect(hook.result.current.images.picking).toBe(false);
    expect(mocks.import).not.toHaveBeenCalled();
    expect(input.value).toBe('before TARGET after');
    await act(async () => {
      expect((await hook.result.current.images.pick())?.inserted).toBe(2);
    });
  });

  it('cancels a mode round trip even when React batches both changes', async () => {
    const { hook, input } = setup();
    const gate = deferred<string[]>();
    mocks.pick.mockReturnValue(gate.promise);
    let operation!: ReturnType<typeof hook.result.current.images.pick>;
    act(() => {
      operation = hook.result.current.images.pick();
    });
    act(() => {
      hook.result.current.session.setSourceMode(false);
      hook.result.current.session.setSourceMode(true);
    });
    await act(async () => {
      gate.resolve(['C:/images/1.png']);
      expect(await operation).toMatchObject({ inserted: 0, reason: 'target-changed' });
    });
    expect(mocks.import).not.toHaveBeenCalled();
    expect(input.value).toBe('before TARGET after');
  });

  it('keeps the original background tab when another tab and its mode change', async () => {
    const { hook, input } = setup();
    const gate = deferred<string[]>();
    mocks.pick.mockReturnValue(gate.promise);
    let operation!: ReturnType<typeof hook.result.current.images.pick>;
    act(() => {
      operation = hook.result.current.images.pick();
    });
    act(() => {
      hook.result.current.session.addTab(
        { title: 'b.md', path: null, isNew: true, content: 'other' },
        'b',
      );
      hook.result.current.session.setSourceMode(true);
    });
    await act(async () => {
      gate.resolve(['C:/images/2.jpg']);
      expect((await operation)?.inserted).toBe(1);
    });
    expect(mocks.import).toHaveBeenCalledWith('C:/images/2.jpg', 'a');
    expect(input.value).toContain('TARGET![](mdplus-image:two)');
    expect(hook.result.current.session.activeId).toBe('b');
  });

  it('releases imported images after a mode round trip during native image reading', async () => {
    const { hook, input } = setup();
    const gate = deferred<string>();
    mocks.import.mockReturnValueOnce(gate.promise);
    mocks.pick.mockResolvedValue(['C:/images/2.jpg']);
    let operation!: ReturnType<typeof hook.result.current.images.pick>;
    await act(async () => {
      operation = hook.result.current.images.pick();
      await Promise.resolve();
    });
    expect(mocks.import).toHaveBeenCalledOnce();
    act(() => {
      hook.result.current.session.setSourceMode(false);
      hook.result.current.session.setSourceMode(true);
    });
    await act(async () => {
      gate.resolve('mdplus-image:two');
      expect(await operation).toMatchObject({ inserted: 0, reason: 'target-changed' });
    });
    expect(mocks.cancel).toHaveBeenCalledWith('a', 'mdplus-image:two');
    expect(hook.result.current.images.progress).toBeNull();
    expect(input.value).toBe('before TARGET after');
  });
});
