// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { clearMocks } from '@tauri-apps/api/mocks';
import { createHash } from 'node:crypto';
import { LIMITS } from '../src/config/constants';
import { createNativeMocks, decodeFixtureBase64, encodeFixtureBytes } from './browser/nativeMocks';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
const image = { filename: 'picture.png', dataBase64: png };
const asset = { docPath: 'C:/fixture/note.md', ...image };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, 'isTauri');
});

describe('strict pure-browser native fixtures', () => {
  it('keeps a complete recovery snapshot and in-flight batch while collecting obsolete images', async () => {
    const native = createNativeMocks();
    const id = 'draft';
    const { key: stashKey } = (await native.invoke('stash_image', image)) as { key: string };
    const cache = (key: string, retainedKeys: string[] = []) =>
      native.invoke('cache_recovery_image', { id, key, stashKey, retainedKeys });
    await cache('old.png');
    const snapshot = {
      id,
      title: 'draft.md',
      originalPath: null,
      markdown: '![](mdplus-image:old)',
      images: [{ key: 'old.png', placeholder: 'mdplus-image:old', filename: 'old.png' }],
    };
    await native.invoke('write_recovery_snapshot', { snapshot, retainedKeys: [] });
    await cache('a.png', ['a.png', 'b.png']);
    await cache('b.png', ['a.png', 'b.png']);
    expect(native.recoveryImages.size).toBe(3);
    const next = { ...snapshot, markdown: 'no images', images: [] };
    expect(
      await native.invoke('write_recovery_snapshot', {
        snapshot: next,
        retainedKeys: ['a.png', 'b.png'],
      }),
    ).toEqual({ removedKeys: ['old.png'], cleanupError: null });
    expect(native.recoveryImages.size).toBe(2);
    await native.invoke('write_recovery_snapshot', { snapshot: next, retainedKeys: [] });
    expect(native.recoveryImages.size).toBe(0);
    await expect(cache('new.png', ['../escape.png'])).rejects.toThrow('invalid recovery image key');
  });
  it('imports a dropped image into an owned stash without changing its source bytes', async () => {
    const bytes = [...decodeFixtureBase64(png)];
    const path = 'C:/drop/picture.png';
    const binaries = new Map([[path, [...bytes]]]);
    const native = createNativeMocks({ binaries });
    const imported = (await native.invoke('import_dropped_image', { path })) as {
      key: string;
      digest: string;
    };
    expect(imported).toMatchObject({
      filename: 'picture.png',
      mime: 'image/png',
      byteLength: bytes.length,
      digest: createHash('sha256').update(Uint8Array.from(bytes)).digest('hex'),
      previewUrl: `data:image/png;base64,${png}`,
    });
    expect(binaries.get(path)).toEqual(bytes);
    expect(native.stashes.size).toBe(1);
    await native.invoke('discard_stashed_images', { keys: [imported.key] });
    expect(native.stashes.size).toBe(0);
    expect(binaries.get(path)).toEqual(bytes);
    await expect(native.invoke('import_dropped_image', { path: 'picture.png' })).rejects.toThrow(
      'absolute Windows path',
    );
    await expect(
      native.invoke('import_dropped_image', { path: 'C:/drop/picture.gif' }),
    ).rejects.toThrow('PNG/JPEG');
    expect(native.stashes.size).toBe(0);
  });

  it('rejects unknown and removed IPC even with a permissive legacy fallback', async () => {
    const fallback = vi.fn(() => undefined);
    const native = createNativeMocks({ fallback });
    await expect(native.invoke('nonexistent_command')).rejects.toThrow('unmocked IPC');
    await expect(native.invoke('plugin:store|save')).rejects.toThrow('unmocked IPC');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('installs a browser-only bridge with real canonical image bytes and preview URLs', async () => {
    const native = createNativeMocks();
    native.install();
    const saved = await invoke<{ key: string; mime: string; previewUrl: string }>(
      'stash_image',
      image,
    );
    expect(saved).toMatchObject({ mime: 'image/png', previewUrl: `data:image/png;base64,${png}` });
    expect(saved.key).toMatch(/^[a-f0-9]{32}$/);
    await expect(invoke('read_stashed_image', { key: saved.key })).resolves.toEqual({
      mime: 'image/png',
      dataBase64: png,
    });
    expect(native.stashBytes).toBe(decodeFixtureBase64(png).length);
    await invoke('discard_stashed_images', { keys: [saved.key] });
    await expect(invoke('read_stashed_image', { key: saved.key })).rejects.toThrow(
      'unknown session',
    );
    expect(native.stashBytes).toBe(0);
  });

  it('rejects malformed/noncanonical base64 and numeric-array production payloads', async () => {
    const native = createNativeMocks();
    for (const dataBase64 of ['YQ', 'YQ=', 'YQ==\n', 'YR==', '!!!!', 'YQ==AAAA', '']) {
      await expect(
        native.invoke('stash_image', { filename: 'p.png', dataBase64 }),
      ).rejects.toThrow();
    }
    await expect(
      native.invoke('stash_image', { filename: 'p.png', data: [1, 2, 3] }),
    ).rejects.toThrow();
    await expect(native.invoke('save_image_asset', { ...asset, data: [1] })).rejects.toThrow();
    expect(native.stashes.size).toBe(0);
    expect(native.binaries.size).toBe(0);
    expect(() => encodeFixtureBytes([256])).toThrow('invalid byte');
    expect(() => encodeFixtureBytes([-1])).toThrow('invalid byte');
    expect(() => encodeFixtureBytes([1.5])).toThrow('invalid byte');
    expect(encodeFixtureBytes(decodeFixtureBase64(png))).toBe(png);
  });

  it('does not evict valid undo data when the byte or entry budget rejects a stash', async () => {
    const native = createNativeMocks({ stashByteLimit: decodeFixtureBase64(png).length });
    const first = (await native.invoke('stash_image', image)) as { key: string };
    await expect(native.invoke('stash_image', image)).rejects.toThrow('stash full');
    await expect(native.invoke('read_stashed_image', { key: first.key })).resolves.toMatchObject({
      dataBase64: png,
    });
    expect(native.stashes.size).toBe(1);
    const byCount = createNativeMocks({ stashEntryLimit: 1 });
    await byCount.invoke('stash_image', image);
    await expect(byCount.invoke('stash_image', image)).rejects.toThrow('too many session');
    expect(byCount.stashes.size).toBe(1);
  });

  it('discards only owned allocations and reuses committed bytes without granting deletion rights', async () => {
    const native = createNativeMocks();
    const first = (await native.invoke('save_image_asset', asset)) as {
      allocationId: string;
      path: string;
    };
    const pending = (await native.invoke('save_image_asset', asset)) as {
      allocationId: string;
      path: string;
    };
    expect(pending.path).not.toBe(first.path);
    await native.invoke('commit_image_assets', { allocationIds: [first.allocationId] });
    const reused = (await native.invoke('save_image_asset', asset)) as {
      allocationId: null;
      path: string;
    };
    expect(reused).toMatchObject({ allocationId: null, path: first.path });
    await native.invoke('discard_image_assets', {
      allocationIds: [first.allocationId, pending.allocationId, 'unknown'],
    });
    expect(native.binaries.has(first.path)).toBe(true);
    expect(native.binaries.has(pending.path)).toBe(false);
    expect(native.allocations.size).toBe(0);
  });

  it('preserves a substituted fixture asset and revokes its stale cleanup authority', async () => {
    const native = createNativeMocks();
    const first = (await native.invoke('save_image_asset', asset)) as {
      allocationId: string;
      path: string;
    };
    const replacement = [1, 2, 3];
    native.binaries.set(first.path, replacement);
    await expect(
      native.invoke('discard_image_assets', { allocationIds: [first.allocationId] }),
    ).rejects.toThrow('identity changed');
    expect(native.binaries.get(first.path)).toBe(replacement);
    expect(native.allocations.size).toBe(0);
    await native.invoke('discard_image_assets', { allocationIds: [first.allocationId] });
    expect(native.binaries.get(first.path)).toBe(replacement);
  });

  it('keeps settings atomic across failures, retries, and revision conflicts', async () => {
    const settings = new Map<string, unknown>([['theme-mode', 'light']]);
    let fail = true;
    const native = createNativeMocks({
      settings,
      beforeSaveSettings: () => {
        if (fail) throw new Error('disk full');
      },
    });
    const loaded = (await native.invoke('load_settings')) as { revision: string };
    const request = { values: { 'theme-mode': 'dark' }, expectedRevision: loaded.revision };
    await expect(native.invoke('save_settings', request)).rejects.toThrow('disk full');
    expect(settings.get('theme-mode')).toBe('light');
    fail = false;
    const saved = (await native.invoke('save_settings', request)) as { revision: string };
    expect(saved.revision).not.toBe(loaded.revision);
    expect(settings.get('theme-mode')).toBe('dark');
    await expect(native.invoke('save_settings', request)).rejects.toThrow('revision conflict');
  });

  it('captures a delayed settings read without making its stale revision writable', async () => {
    const gate = deferred();
    const settings = new Map<string, unknown>([['theme-mode', 'light']]);
    const native = createNativeMocks({ settings, beforeLoadSettings: () => gate.promise });
    const loading = native.invoke('load_settings');
    await Promise.resolve();
    settings.set('theme-mode', 'external');
    gate.resolve();
    const stale = (await loading) as { values: Record<string, unknown>; revision: string };
    expect(stale.values['theme-mode']).toBe('light');
    stale.values['theme-mode'] = 'local';
    await expect(
      native.invoke('save_settings', { values: stale.values, expectedRevision: stale.revision }),
    ).rejects.toThrow('revision conflict');
    expect(settings.get('theme-mode')).toBe('external');
  });

  it('rechecks CAS after the settings save gate without committing external changes away', async () => {
    const settings = new Map<string, unknown>([['theme-mode', 'light']]);
    const native = createNativeMocks({
      settings,
      beforeSaveSettings: () => {
        settings.set('theme-mode', 'external');
      },
    });
    const loaded = (await native.invoke('load_settings')) as { revision: string };
    await expect(
      native.invoke('save_settings', {
        values: { 'theme-mode': 'local' },
        expectedRevision: loaded.revision,
      }),
    ).rejects.toThrow('changed during save');
    expect(settings.get('theme-mode')).toBe('external');
  });

  it('rejects oversized settings before save hooks and preserves the prior map', async () => {
    const beforeSaveSettings = vi.fn();
    const native = createNativeMocks({ beforeSaveSettings });
    await expect(
      native.invoke('save_settings', {
        values: { huge: 'x'.repeat(LIMITS.settingsFileBytes) },
        expectedRevision: null,
      }),
    ).rejects.toThrow('settings exceed');
    expect(beforeSaveSettings).not.toHaveBeenCalled();
    expect(native.settings.size).toBe(0);
  });

  it('bridges legacy image reads without bypassing their I/O delay or changing bytes', async () => {
    const gate = deferred();
    let started = false;
    const native = createNativeMocks({
      legacyImagePayloads: true,
      fallback: async (command) => {
        if (command !== 'read_image_file') throw new Error(`unexpected ${command}`);
        started = true;
        await gate.promise;
        return { path: 'C:/fixture/p.png', mime: 'image/png', data: [...decodeFixtureBase64(png)] };
      },
    });
    let settled = false;
    const reading = native.invoke('read_image_file', {
      docPath: 'C:/fixture/n.md',
      relativePath: 'p.png',
    });
    void reading.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(started).toBe(true));
    expect(settled).toBe(false);
    gate.resolve();
    await expect(reading).resolves.toEqual({
      path: 'C:/fixture/p.png',
      mime: 'image/png',
      dataBase64: png,
    });
  });

  it('validates compact writes before forwarding legacy bytes and retains original I/O failures', async () => {
    const failure = new Error('original fixture disk failure');
    const fallback = vi.fn(() => {
      throw failure;
    });
    const native = createNativeMocks({ legacyImagePayloads: true, fallback });
    const { key: stashKey } = (await native.invoke('stash_image', image)) as { key: string };
    await expect(
      native.invoke('cache_recovery_image', {
        id: 'tab',
        key: 'p.png',
        stashKey,
        retainedKeys: [],
      }),
    ).rejects.toBe(failure);
    expect(fallback.mock.calls[0]).toEqual([
      'cache_recovery_image',
      expect.objectContaining({ data: [...decodeFixtureBase64(png)] }),
    ]);
    await expect(native.invoke('save_image_asset', asset)).rejects.toBe(failure);
    expect(native.allocations.size).toBe(0);
    const calls = fallback.mock.calls.length;
    await expect(
      native.invoke('save_image_asset', { ...asset, dataBase64: 'bad' }),
    ).rejects.toThrow();
    expect(fallback).toHaveBeenCalledTimes(calls);
  });

  it('adds ownership to a successful legacy asset without deleting another fixture object', async () => {
    const binaries = new Map<string, number[]>();
    const path = 'C:/fixture/assets/picture.png';
    const native = createNativeMocks({
      binaries,
      legacyImagePayloads: true,
      fallback: (command, args) => {
        if (command !== 'save_image_asset') throw new Error(`unexpected ${command}`);
        binaries.set(path, args.data as number[]);
        return { filename: 'picture.png', relativePath: './assets/picture.png', path };
      },
    });
    const receipt = (await native.invoke('save_image_asset', asset)) as { allocationId: string };
    expect(binaries.get(path)).toEqual([...decodeFixtureBase64(png)]);
    await native.invoke('discard_image_assets', { allocationIds: [receipt.allocationId] });
    expect(binaries.has(path)).toBe(false);
  });

  it('converts restored legacy image payloads and keeps dedicated settings handlers intact', async () => {
    const snapshot = { id: 'old' };
    const fallback = vi.fn((command: string) => {
      if (command === 'load_settings') throw new Error('original load failure');
      if (command === 'read_recovery_snapshot')
        return {
          snapshot,
          images: [{ key: 'p.png', mime: 'image/png', data: [...decodeFixtureBase64(png)] }],
        };
      throw new Error(`unexpected ${command}`);
    });
    const native = createNativeMocks({
      fallback,
      legacyImagePayloads: true,
      settingsMode: 'delegate',
    });
    await expect(native.invoke('load_settings')).rejects.toThrow('original load failure');
    await expect(native.invoke('read_recovery_snapshot', { id: 'old' })).resolves.toEqual({
      snapshot,
      images: [{ key: 'p.png', mime: 'image/png', dataBase64: png }],
    });
  });

  it('preserves modern fixture finalization gates and errors instead of treating foreign tokens as success', async () => {
    const gate = deferred();
    const id = 'a'.repeat(32);
    let fail = true;
    let finalizing = false;
    const native = createNativeMocks({
      fallback: async (command, args) => {
        if (command === 'save_image_asset')
          return {
            filename: 'picture.png',
            path: 'C:/fixture/assets/picture.png',
            relativePath: './assets/picture.png',
            allocationId: id,
          };
        if (command === 'commit_image_assets') {
          expect(args.allocationIds).toEqual([id]);
          finalizing = true;
          await gate.promise;
          if (fail) throw new Error('commit transport failed');
          return;
        }
        throw new Error(`unexpected ${command}`);
      },
    });
    await native.invoke('save_image_asset', asset);
    const first = native.invoke('commit_image_assets', { allocationIds: [id] });
    const failed = expect(first).rejects.toThrow('commit transport failed');
    await vi.waitFor(() => expect(finalizing).toBe(true));
    gate.resolve();
    await failed;
    fail = false;
    await native.invoke('commit_image_assets', { allocationIds: [id] });
  });

  it('does not confuse recovery cleanup with session image lifetime', async () => {
    const native = createNativeMocks();
    const stashed = (await native.invoke('stash_image', image)) as { key: string };
    const snapshot = {
      id: 'tab',
      title: 'draft',
      originalPath: null,
      markdown: '![](mdplus-image:p)',
      images: [{ key: 'p.png', filename: 'p.png', placeholder: 'mdplus-image:p' }],
    };
    await expect(
      native.invoke('write_recovery_snapshot', { snapshot, retainedKeys: [] }),
    ).rejects.toThrow('uncached image');
    await native.invoke('cache_recovery_image', {
      id: 'tab',
      key: 'p.png',
      stashKey: stashed.key,
      retainedKeys: [],
    });
    await native.invoke('write_recovery_snapshot', { snapshot, retainedKeys: [] });
    await native.invoke('delete_recovery_snapshot', { id: 'tab' });
    expect(native.recoverySnapshots.size).toBe(0);
    expect(native.recoveryImages.size).toBe(0);
    await expect(native.invoke('read_stashed_image', { key: stashed.key })).resolves.toMatchObject({
      dataBase64: png,
    });
  });

  it('copies recovery bytes by held stash key and rejects raw bytes or unknown keys', async () => {
    const native = createNativeMocks();
    const { key: stashKey } = (await native.invoke('stash_image', image)) as { key: string };
    const request = { id: 'tab', key: 'p.png', stashKey, retainedKeys: [] };
    await native.invoke('cache_recovery_image', request);
    expect(native.recoveryImages.get('tab/p.png')?.dataBase64).toBe(png);
    await expect(
      native.invoke('cache_recovery_image', { ...request, dataBase64: png }),
    ).rejects.toThrow('stashKey only');
    await expect(
      native.invoke('cache_recovery_image', { ...request, stashKey: 'missing' }),
    ).rejects.toThrow('unknown session image key');
    expect(native.recoveryImages.size).toBe(1);
  });

  it('does not pretend an unstubbed document write succeeded and defaults dialogs to cancellation', async () => {
    const native = createNativeMocks();
    await expect(
      native.invoke('write_document', {
        path: 'C:/real.md',
        content: 'no',
        expectedRevision: null,
      }),
    ).rejects.toThrow('unmocked IPC');
    await expect(native.invoke('plugin:dialog|save')).resolves.toBeNull();
    await expect(native.invoke('plugin:dialog|message', { buttons: 'YesNo' })).resolves.toBe('No');
  });
});
