import { RECOVERY_DELAY_MS } from '../config/constants';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  capturePendingImages,
  getInFlightImages,
  restorePendingImages,
  stagePendingImages,
  type PendingImageLease,
} from './imageOps';
import { getImageUrls, isRelativeImageUrl, rewriteImageReferences } from './imagePaths';
import type { Tab } from './types';

export interface RecoveryImage {
  placeholder: string;
  filename: string;
  key: string;
}
export interface RecoverySnapshot {
  id: string;
  title: string;
  originalPath: string | null;
  markdown: string;
  images: RecoveryImage[];
}
export interface RecoveryEntry {
  id: string;
  title: string;
  originalPath: string | null;
  updatedAt: number;
  damaged: boolean;
}
export type RecoveryStatus = 'pending' | 'protected' | 'error' | 'idle';

export interface RecoveryCleanup {
  removedKeys: string[];
  cleanupError: string | null;
}

interface PendingCapture {
  value: ReturnType<typeof capture> | null;
}
interface Journal {
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
  pending?: PendingCapture;
  tail: Promise<unknown>;
  cached: Set<string>;
}
function releasePendingCapture(entry: Journal): void {
  const pending = entry.pending;
  entry.pending = undefined;
  if (!pending) return;
  const value = pending.value;
  pending.value = null;
  value?.lease.release();
}
const journals = new Map<string, Journal>();
function journal(id: string): Journal {
  let value = journals.get(id);
  if (!value) {
    value = { generation: 0, tail: Promise.resolve(), cached: new Set() };
    journals.set(id, value);
  }
  return value;
}
function enqueue<T>(entry: Journal, task: () => Promise<T>): Promise<T> {
  const operation = entry.tail.catch(() => {}).then(task);
  entry.tail = operation;
  return operation;
}

function imageKey(image: { placeholder: string; filename: string }): string {
  return `${image.placeholder.slice('mdplus-image:'.length)}.${image.filename.split('.').pop()!.toLowerCase()}`;
}

function retainedKeys(
  id: string,
  entry: Journal,
  images: readonly { placeholder: string; filename: string }[],
): string[] {
  return [
    ...new Set(
      [...getInFlightImages(id), ...(entry.pending?.value?.images ?? []), ...images].map(imageKey),
    ),
  ];
}
function applyCleanup(entry: Journal, cleanup: RecoveryCleanup): void {
  for (const key of cleanup.removedKeys) entry.cached.delete(key);
  if (cleanup.cleanupError) {
    entry.cached.clear();
    console.warn('恢复图片回收未完成，将在下次写入时重试', cleanup.cleanupError);
  }
}

async function cacheImage(
  id: string,
  image: { placeholder: string; filename: string },
  entry: Journal,
  lease: PendingImageLease,
  images: readonly { placeholder: string; filename: string }[],
) {
  const key = imageKey(image);
  if (!entry.cached.has(key)) {
    try {
      const cleanup = await lease.withStashKey(image.placeholder, (stashKey) =>
        invoke<RecoveryCleanup>('cache_recovery_image', {
          id,
          key,
          stashKey,
          retainedKeys: retainedKeys(id, entry, images),
        }),
      );
      applyCleanup(entry, cleanup);
      entry.cached.add(key);
    } catch (error) {
      entry.cached.clear();
      throw error;
    }
  }
}

/** The paste handler must await this before inserting the image reference. */
export async function protectPastedImage(
  id: string,
  placeholder: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isTauri()) return;
  const lease = capturePendingImages(id, [placeholder]);
  try {
    const image = lease.images.find((image) => image.placeholder === placeholder);
    if (!image) throw new Error('图片缓存不可用，粘贴已取消');
    const entry = journal(id);
    await enqueue(entry, async () => {
      if (!isCurrent()) throw new Error('图片粘贴已取消');
      await cacheImage(id, image, entry, lease, lease.images);
    });
  } finally {
    lease.release();
  }
}

function capture(tab: Pick<Tab, 'id' | 'title' | 'path' | 'markdown'>) {
  const urls = new Set(getImageUrls(tab.markdown));
  const lease = capturePendingImages(tab.id, urls);
  try {
    const images = lease.images.map((image) => ({
      placeholder: image.placeholder,
      filename: image.filename,
      key: imageKey(image),
      sourceUrl: image.source?.url,
      byteLength: image.byteLength,
    }));
    for (const url of urls) {
      if (
        (/^mdplus-image:/i.test(url) || isRelativeImageUrl(url)) &&
        !images.some(
          (image) => (image.placeholder === url || image.sourceUrl === url) && image.byteLength > 0,
        )
      ) {
        throw new Error('恢复快照缺少图片数据，请立即手动保存文档');
      }
    }
    const markdown = rewriteImageReferences(
      tab.markdown,
      images
        .filter((image) => image.sourceUrl)
        .map((image) => ({ placeholder: image.sourceUrl!, relativePath: image.placeholder })),
    );
    const snapshot: RecoverySnapshot = {
      id: tab.id,
      title: tab.title,
      originalPath: tab.path,
      markdown,
      images: images.map(({ placeholder, filename, key }) => ({ placeholder, filename, key })),
    };
    return { snapshot, images, lease };
  } catch (error) {
    lease.release();
    throw error;
  }
}

export function scheduleRecovery(
  tab: Pick<Tab, 'id' | 'title' | 'path' | 'markdown'>,
  onStatus: (status: RecoveryStatus) => void,
  ready?: Promise<boolean>,
): void {
  if (!isTauri()) return;
  const id = tab.id;
  const entry = journal(id);
  const generation = ++entry.generation;
  clearTimeout(entry.timer);
  entry.timer = undefined;
  releasePendingCapture(entry);
  onStatus('pending');
  const fail = () => {
    if (entry.generation === generation) onStatus('error');
  };
  const captureAndSchedule = () => {
    if (entry.generation !== generation) return;
    // A cancellable cell avoids retaining whole obsolete drafts behind slow I/O.
    let pending: PendingCapture;
    try {
      pending = { value: capture(tab) };
    } catch {
      fail();
      return;
    }
    entry.pending = pending;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void enqueue(entry, async () => {
        const data = pending.value;
        pending.value = null;
        if (entry.pending === pending) entry.pending = undefined;
        if (!data) return;
        try {
          if (entry.generation !== generation) return;
          for (const image of data.images) {
            if (entry.generation !== generation) return;
            await cacheImage(id, image, entry, data.lease, data.images);
          }
          if (entry.generation !== generation) return;
          try {
            applyCleanup(
              entry,
              await invoke<RecoveryCleanup>('write_recovery_snapshot', {
                snapshot: data.snapshot,
                retainedKeys: retainedKeys(id, entry, data.images),
              }),
            );
          } catch (error) {
            entry.cached.clear();
            throw error;
          }
          if (entry.generation === generation) onStatus('protected');
        } finally {
          data.lease.release();
        }
      }).catch(fail);
    }, RECOVERY_DELAY_MS);
  };
  if (ready)
    void ready.then((prepared) => {
      if (prepared) captureAndSchedule();
      else fail();
    }, fail);
  else captureAndSchedule();
}

/** Serialize deletion after pending image/snapshot writes, so they cannot resurrect a draft. */
export async function clearRecovery(id: string): Promise<void> {
  if (!isTauri()) return;
  const entry = journal(id);
  ++entry.generation;
  clearTimeout(entry.timer);
  entry.timer = undefined;
  releasePendingCapture(entry);
  await enqueue(entry, async () => {
    try {
      await invoke('delete_recovery_snapshot', { id });
    } finally {
      entry.cached.clear();
    }
  });
}

export async function listRecovery(activeIds: string[] = []): Promise<RecoveryEntry[]> {
  if (!isTauri()) return [];
  return invoke('list_recovery_snapshots', { activeIds });
}

export interface PreparedRecovery {
  snapshot: RecoverySnapshot;
  /** Publish only after the caller has rechecked the owning tab/session identity. */
  commit: () => boolean;
  dispose: () => Promise<void>;
}

/** Read/stash outside the commit; deletion invalidates outstanding reads. */
export async function prepareRecovery(id: string): Promise<PreparedRecovery> {
  const entry = journal(id);
  const generation = entry.generation;
  const restored = await invoke<{
    snapshot: RecoverySnapshot;
    images: (RecoveryImage & { dataBase64: string; mime: string })[];
  }>('read_recovery_snapshot', { id });
  const snapshot = restored.snapshot;
  if (snapshot.id !== id) throw new Error('恢复副本身份不匹配，未替换当前内容');
  if (entry.generation !== generation)
    return { snapshot, commit: () => false, dispose: async () => {} };
  const cachedKeys = restored.images.map((image) => image.key);
  const stage = await stagePendingImages(restored.images);
  let consumed = false;
  let committed = false;
  return {
    snapshot,
    commit: () => {
      if (consumed || entry.generation !== generation) return false;
      consumed = true;
      restorePendingImages(id, stage);
      committed = true;
      ++entry.generation;
      entry.cached.clear();
      cachedKeys.forEach((key) => entry.cached.add(key));
      return true;
    },
    dispose: async () => {
      if (committed) return;
      consumed = true;
      await stage.dispose();
    },
  };
}

/** Standalone adapter; the session coordinator uses the staged API above. */
export async function restoreRecovery(id: string): Promise<RecoverySnapshot> {
  const prepared = await prepareRecovery(id);
  try {
    if (!prepared.commit()) throw new Error('恢复请求已失效，副本可能已被删除或重新恢复');
    return prepared.snapshot;
  } finally {
    await prepared.dispose();
  }
}
