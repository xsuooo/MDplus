// @vitest-environment jsdom
import path from 'node:path';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  message: vi.fn(),
  confirm: vi.fn(),
  pickTarget: vi.fn(),
  pushRecent: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => path.win32.join(...parts),
  dirname: async (file: string) => path.win32.dirname(file),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: mocks.pickTarget }));
vi.mock('../src/lib/dialog', () => ({
  showMessage: mocks.message,
  confirmDialog: mocks.confirm,
}));
vi.mock('../src/lib/editor', () => ({ setMarkdown: vi.fn() }));
vi.mock('../src/lib/store', () => ({
  getRecentFiles: async () => [],
  pushRecentFile: mocks.pushRecent,
}));

import { AUTO_SAVE_MS, IMAGE_PREPARATION_MS, RECOVERY_DELAY_MS } from '../src/config/constants';
import { useDocumentSave } from '../src/hooks/useDocumentSave';
import { useWorkspace } from '../src/hooks/useWorkspace';
import { useRecovery } from '../src/hooks/useRecovery';
import { clearPendingImages, prepareImageReferences, imagePreviewUrl } from '../src/lib/imageOps';
import { computeStats } from '../src/lib/stats';
import type { Tab } from '../src/lib/types';
import {
  A,
  B,
  base64,
  both,
  createNative,
  notePath,
  one,
  otherPath,
  previewA,
} from './imageStashNative';

let native: ReturnType<typeof createNative>;
let id: string;
let sequence = 0;
const setRecent = vi.fn();
const commands = () => mocks.invoke.mock.calls.map(([command]) => command as string);

/** The saved document holds image A; the unsaved edit adds a reference to image B. */
const edited = (): Tab => ({
  id,
  title: 'note.md',
  path: notePath,
  isNew: false,
  dirty: true,
  preserveLocal: false,
  diskMtime: 1,
  diskRevision: 'rev-1',
  externalChanged: false,
  initialContent: one,
  savedContent: one,
  markdown: both,
  stats: computeStats(both),
});

async function mount() {
  const tabs = [edited()];
  const hook = renderHook(() => {
    const workspace = useWorkspace(tabs);
    const recovery = useRecovery(workspace);
    const save = useDocumentSave(workspace, recovery, setRecent);
    return { workspace, recovery, save };
  });
  // Settles the recovery listing that the hook starts on mount.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return hook;
}

beforeEach(async () => {
  vi.useFakeTimers();
  id = `stash-full-save-${++sequence}`;
  native = createNative();
  native.documents.set(notePath, { content: one, revision: 'rev-1', mtime: 1 });
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(native.invoke);
  mocks.message.mockReset();
  mocks.message.mockResolvedValue(undefined);
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  mocks.pickTarget.mockReset();
  mocks.pushRecent.mockReset();
  mocks.pushRecent.mockResolvedValue(undefined);
  setRecent.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // Image A was cached while the stash still had room.
  const prepared = await prepareImageReferences(id, one, notePath);
  expect(prepared.commit()).toBe(true);
  await prepared.dispose();
  native.state.full = true;
});

afterEach(() => {
  cleanup();
  clearPendingImages(id);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('saving and protecting a document while the image stash is full', () => {
  it('writes the text on a manual save and keeps the cached image', async () => {
    const hook = await mount();

    let saved = false;
    await act(async () => {
      saved = await hook.result.current.save.doSave(id, { manual: true });
    });

    expect(mocks.message.mock.calls).toEqual([]);
    expect(saved).toBe(true);
    expect(native.documents.get(notePath)).toMatchObject({ content: both, revision: 'rev-2' });
    expect(hook.result.current.workspace.tabs[0]).toMatchObject({
      dirty: false,
      savedContent: both,
      diskRevision: 'rev-2',
    });
    expect(imagePreviewUrl(id, './img/a.png')).toBe(previewA);
    expect([...native.stash.values()]).toEqual([base64(A)]);
    expect(commands()).not.toContain('save_image_asset');
    expect(commands()).not.toContain('discard_stashed_images');
  });

  it('writes the text on autosave without pausing it', async () => {
    const hook = await mount();

    act(() => hook.result.current.save.scheduleAutoSave(id));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SAVE_MS);
      await hook.result.current.workspace.tabRuntime.current[id]?.saveQueue;
    });

    expect(mocks.message.mock.calls).toEqual([]);
    expect(native.documents.get(notePath)).toMatchObject({ content: both, revision: 'rev-2' });
    expect(hook.result.current.workspace.tabs[0]).toMatchObject({
      dirty: false,
      savedContent: both,
      diskRevision: 'rev-2',
    });
    expect(hook.result.current.workspace.isAutoSavePaused(id)).toBe(false);
    expect(imagePreviewUrl(id, './img/a.png')).toBe(previewA);
  });

  it('copies both images when saving as a file in another directory', async () => {
    const hook = await mount();
    mocks.pickTarget.mockResolvedValue(otherPath);

    let saved = false;
    await act(async () => {
      saved = await hook.result.current.save.doSave(id, { manual: true, saveAs: true });
    });

    expect(mocks.message.mock.calls).toEqual([]);
    expect(saved).toBe(true);
    expect(native.documents.get(otherPath)?.content).toBe(
      '![a](./assets/1-a.png)\n\n![b](./assets/2-b.png)',
    );
    expect([...native.assets.values()].map((asset) => asset.dataBase64)).toEqual([
      base64(A),
      base64(B),
    ]);
    expect(native.documents.get(notePath)).toMatchObject({ content: one, revision: 'rev-1' });
    expect(hook.result.current.workspace.tabs[0]).toMatchObject({ path: otherPath, dirty: false });
  });

  it('protects the draft with an owned copy of both images', async () => {
    const hook = await mount();

    act(() =>
      hook.result.current.recovery.saveRecoverySnapshot(hook.result.current.workspace.tabs[0]),
    );
    const preparation =
      hook.result.current.workspace.tabRuntime.current[id]?.imagePreparation?.promise;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IMAGE_PREPARATION_MS);
      await expect(preparation).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS);
    });

    expect(hook.result.current.recovery.recoveryStates[id]).toBe('protected');
    const snapshot = native.snapshots.at(-1)!;
    expect(snapshot.images.map((image) => native.recovery.get(`${id}/${image.key}`))).toEqual([
      base64(A),
      base64(B),
    ]);
    expect(mocks.message.mock.calls).toEqual([]);
  });
});
