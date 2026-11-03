import { invoke, isTauri } from '@tauri-apps/api/core';
import { getPendingImages, restorePendingImages } from './imageOps';
import { getImageUrls, isRelativeImageUrl, rewriteImageReferences } from './imagePaths';
import type { Tab } from './types';

export interface RecoveryImage { placeholder: string; filename: string; key: string }
export interface RecoverySnapshot {
  id: string;
  title: string;
  originalPath: string | null;
  markdown: string;
  images: RecoveryImage[];
}
export interface RecoveryEntry {
  id: string; title: string; originalPath: string | null; updatedAt: number; damaged: boolean;
}
export type RecoveryStatus = 'pending' | 'protected' | 'error' | 'idle';

interface Journal {
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
  tail: Promise<unknown>;
  cached: Set<string>;
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

async function cacheImage(id: string, image: { placeholder: string; filename: string; data: number[] }, entry: Journal) {
  const key = imageKey(image);
  if (!entry.cached.has(key)) {
    await invoke('cache_recovery_image', { id, key, data: image.data });
    entry.cached.add(key);
  }
}

/** The paste handler must await this before inserting the image reference. */
export async function protectPastedImage(id: string, placeholder: string): Promise<void> {
  if (!isTauri()) return;
  const image = getPendingImages(id).find((image) => image.placeholder === placeholder);
  if (!image) throw new Error('图片缓存不可用，粘贴已取消');
  const entry = journal(id);
  await enqueue(entry, () => cacheImage(id, image, entry));
}

function capture(tab: Pick<Tab, 'id' | 'title' | 'path' | 'markdown'>) {
  const urls = new Set(getImageUrls(tab.markdown));
  const images = getPendingImages(tab.id)
    .filter((image) => urls.has(image.placeholder) || (!!image.source && urls.has(image.source.url)))
    .map((image) => ({
      placeholder: image.placeholder, filename: image.filename, key: imageKey(image),
      sourceUrl: image.source?.url, data: image.data,
    }));
  for (const url of urls) {
    if ((url.startsWith('mdplus-image:') || isRelativeImageUrl(url))
      && !images.some((image) => (image.placeholder === url || image.sourceUrl === url) && image.data.length > 0)) {
      throw new Error('恢复快照缺少图片数据，请立即手动保存文档');
    }
  }
  const markdown = rewriteImageReferences(tab.markdown, images.filter((image) => image.sourceUrl)
    .map((image) => ({ placeholder: image.sourceUrl!, relativePath: image.placeholder })));
  const snapshot: RecoverySnapshot = {
    id: tab.id, title: tab.title, originalPath: tab.path, markdown,
    images: images.map(({ placeholder, filename, key }) => ({ placeholder, filename, key })),
  };
  return { snapshot, images };
}

export function scheduleRecovery(tab: Pick<Tab, 'id' | 'title' | 'path' | 'markdown'>,
  onStatus: (status: RecoveryStatus) => void, ready?: Promise<boolean>): void {
  if (!isTauri()) return;
  const entry = journal(tab.id);
  const generation = ++entry.generation;
  clearTimeout(entry.timer);
  entry.timer = undefined;
  onStatus('pending');
  const fail = () => { if (entry.generation === generation) onStatus('error'); };
  const captureAndSchedule = () => {
    if (entry.generation !== generation) return;
    // Without a preparation barrier, freeze aliases synchronously before Save As changes them.
    let data: ReturnType<typeof capture>;
    try { data = capture(tab); } catch { fail(); return; }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void enqueue(entry, async () => {
        if (entry.generation !== generation) return;
        for (const image of data.images) await cacheImage(tab.id, image, entry);
        if (entry.generation !== generation) return;
        await invoke('write_recovery_snapshot', { snapshot: data.snapshot });
        if (entry.generation === generation) onStatus('protected');
      }).catch(fail);
    }, 1000);
  };
  if (ready) void ready.then((prepared) => { if (prepared) captureAndSchedule(); else fail(); }, fail);
  else captureAndSchedule();
}

/** Serialize deletion after pending image/snapshot writes, so they cannot resurrect a draft. */
export async function clearRecovery(id: string): Promise<void> {
  if (!isTauri()) return;
  const entry = journal(id);
  ++entry.generation;
  clearTimeout(entry.timer);
  entry.timer = undefined;
  await enqueue(entry, async () => {
    await invoke('delete_recovery_snapshot', { id });
    entry.cached.clear();
  });
}

export async function listRecovery(activeIds: string[] = []): Promise<RecoveryEntry[]> {
  if (!isTauri()) return [];
  return invoke('list_recovery_snapshots', { activeIds });
}

export async function restoreRecovery(id: string): Promise<RecoverySnapshot> {
  const restored = await invoke<{
    snapshot: RecoverySnapshot;
    images: (RecoveryImage & { data: number[]; mime: string })[];
  }>('read_recovery_snapshot', { id });
  restorePendingImages(id, restored.images);
  const entry = journal(id);
  restored.images.forEach((image) => entry.cached.add(image.key));
  return restored.snapshot;
}
