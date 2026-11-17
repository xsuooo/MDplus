/** Per-tab cache of pending images: identities, listeners, reachability and garbage collection. */
import { serialQueue } from '../serialQueue';
import { invoke } from '@tauri-apps/api/core';
import { type UrlRewrite } from '../imagePaths';

/** Public snapshots contain identities, never a second copy of the image bytes. */
export interface PendingImage extends UrlRewrite {
  filename: string;
  mime: string;
  byteLength: number;
  source?: { url: string; absolutePath: string };
  /** Set only while the bytes still live in the document's own image file. */
  file?: PendingImageFile;
}
/** Where an image that the full stash could not admit is read from, and what it must hash to. */
export interface PendingImageFile {
  docPath: string;
  relativePath: string;
  digest: string;
}
export interface BackingBase {
  mime: string;
  byteLength: number;
  digest: string;
  owners: number;
}
export interface StashBacking extends BackingBase {
  key: string;
  /** A process-owned, read-only native URL, not a retained JS binary/data URL. */
  previewUrl: string;
}
/**
 * The stash had no room, so nothing native is owned: the bytes are the document's
 * image file, re-read and checked against `digest` whenever they are needed.
 */
export interface FileBacking extends BackingBase {
  key: null;
  previewUrl: null;
  file: { docPath: string; relativePath: string };
}
export type ImageBacking = StashBacking | FileBacking;
export interface CachedImage extends PendingImage {
  backing: ImageBacking;
  inserting?: boolean;
}
export interface ImageCache {
  images: Map<string, CachedImage>;
  aliases: Map<string, string>;
  generation: number;
  docPath: string | null;
}
export const imageCaches = new Map<string, ImageCache>();
export const imageListeners = new Map<string, Set<() => void>>();
export const imageRoots = new Map<string, Set<() => Iterable<string>>>();
export const collectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Serialize complete read/encode/write operations, not just individual invokes:
// otherwise many tabs can keep a 64 MiB base64 result alive while queued to write.
export const imageIO = serialQueue();
export function cacheFor(tabId: string): ImageCache {
  let cache = imageCaches.get(tabId);
  if (!cache) {
    cache = { images: new Map(), aliases: new Map(), generation: 0, docPath: null };
    imageCaches.set(tabId, cache);
  }
  return cache;
}
export function notifyImages(tabId: string): void {
  for (const listener of [...(imageListeners.get(tabId) ?? [])]) {
    try {
      listener();
    } catch (error) {
      console.error('图片预览刷新失败', error);
    }
  }
}
export function changed(tabId: string, cache: ImageCache, notify = true): void {
  cache.generation += 1;
  if (notify) notifyImages(tabId);
}
/** Preview-only subscription: never publishes an editor content update. */
export function subscribeImageSources(tabId: string, listener: () => void): () => void {
  let listeners = imageListeners.get(tabId);
  if (!listeners) imageListeners.set(tabId, (listeners = new Set()));
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && imageListeners.get(tabId) === listeners) imageListeners.delete(tabId);
  };
}

/** Include current text AND both undo/redo branches. Missing roots retain conservatively. */
export function registerImageReachability(
  tabId: string,
  collect: () => Iterable<string>,
): () => void {
  let roots = imageRoots.get(tabId);
  if (!roots) imageRoots.set(tabId, (roots = new Set()));
  roots.add(collect);
  return () => {
    roots.delete(collect);
    if (!roots.size && imageRoots.get(tabId) === roots) imageRoots.delete(tabId);
  };
}
export function imageReferencesChanged(tabId: string): void {
  clearTimeout(collectionTimers.get(tabId));
  collectionTimers.set(
    tabId,
    setTimeout(() => {
      collectionTimers.delete(tabId);
      void collectUnusedImages(tabId).catch((error) => console.error('图片暂存回收失败', error));
    }, 1000),
  );
}
export async function releaseBacking(backing: ImageBacking): Promise<void> {
  if (--backing.owners > 0 || backing.key === null) return;
  await invoke('discard_stashed_images', { keys: [backing.key] });
}
export function quietlyRelease(backing: ImageBacking): void {
  void releaseBacking(backing).catch((error) => console.error('释放图片暂存失败', error));
}
/** Reclaim only images proven unreachable by every live editor and capture lease. */
export async function collectUnusedImages(tabId?: string): Promise<void> {
  const discarded: Promise<void>[] = [];
  for (const [id, cache] of imageCaches) {
    if (tabId !== undefined && tabId !== id) continue;
    // No native backing can be reclaimed; do not parse the document and its history.
    if (!cache.images.size) continue;
    const roots = imageRoots.get(id);
    if (!roots?.size) continue;
    const reachable = new Set<string>();
    try {
      for (const collect of roots) {
        for (const url of collect()) reachable.add(cache.aliases.get(url) ?? url);
      }
    } catch {
      // An editor transitioning between modes is not proof that its history is gone.
      continue;
    }
    let removed = false;
    let unstashedRemoved = false;
    for (const [token, image] of cache.images) {
      if (image.inserting || image.backing.owners > 1 || reachable.has(token)) continue;
      removed = true;
      unstashedRemoved ||= image.backing.key === null;
      cache.images.delete(token);
      for (const [url, owner] of cache.aliases) if (owner === token) cache.aliases.delete(url);
      discarded.push(releaseBacking(image.backing));
    }
    // Only the count of images without a preview is visible; previews themselves are not.
    if (removed) changed(id, cache, unstashedRemoved);
  }
  await Promise.all(discarded);
}
/** Call after insertion, or after a paste is rejected by its generation check. */
export function settleImageInsertion(tabId: string, placeholder: string): void {
  const image = imageCaches.get(tabId)?.images.get(placeholder);
  if (image) image.inserting = false;
  imageReferencesChanged(tabId);
}

/** Failed batches own no editor reference: release them immediately, including
 * when a recovery queue still holds its independent read lease. */
export async function cancelImageInsertion(tabId: string, placeholder: string): Promise<void> {
  const cache = imageCaches.get(tabId);
  const image = cache?.images.get(placeholder);
  if (!cache || !image?.inserting) return;
  cache.images.delete(placeholder);
  for (const [url, token] of cache.aliases) if (token === placeholder) cache.aliases.delete(url);
  changed(tabId, cache);
  await releaseBacking(image.backing);
}

export function snapshotImage(cache: ImageCache, image: CachedImage): PendingImage {
  const { placeholder, relativePath, filename, mime, byteLength, backing } = image;
  // A retired token owns its immutable stash, never somebody else's current disk URL.
  const source =
    image.source && cache.aliases.get(image.source.url) === placeholder
      ? { ...image.source }
      : undefined;
  return {
    placeholder,
    relativePath,
    filename,
    mime,
    byteLength,
    source,
    ...(backing.key === null ? { file: { ...backing.file, digest: backing.digest } } : {}),
  };
}
export function getPendingImages(tabId: string): PendingImage[] {
  const cache = imageCaches.get(tabId);
  return cache ? [...cache.images.values()].map((image) => snapshotImage(cache, image)) : [];
}
/** Recovery duplicates need pins for insertion/captures; undo bytes stay in the independent stash. */
export function getInFlightImages(tabId: string): PendingImage[] {
  const cache = imageCaches.get(tabId);
  return cache
    ? [...cache.images.values()]
        .filter((image) => image.inserting || image.backing.owners > 1)
        .map((image) => snapshotImage(cache, image))
    : [];
}
export function clearPendingImages(tabId: string): void {
  const cache = imageCaches.get(tabId);
  imageCaches.delete(tabId);
  clearTimeout(collectionTimers.get(tabId));
  collectionTimers.delete(tabId);
  if (cache) for (const image of cache.images.values()) quietlyRelease(image.backing);
  notifyImages(tabId);
}
/**
 * Canonical identities for editor history; source text itself need not be rewritten.
 * An image left in its file is not offered: its token owns no bytes and is replaced
 * whenever the file changes, so editors and their history keep the raw URL.
 */
export function imageIdentityReferences(tabId: string): UrlRewrite[] {
  const cache = imageCaches.get(tabId);
  return [...(cache?.aliases ?? [])].flatMap(([url, token]) =>
    cache!.images.get(token)?.backing.key === null
      ? []
      : [{ placeholder: url, relativePath: token }],
  );
}
export function imageTokenForUrl(tabId: string, url: string): string {
  const cache = imageCaches.get(tabId);
  const token = cache?.aliases.get(url);
  return token !== undefined && cache!.images.get(token)?.backing.key !== null ? token : url;
}
/** Only expose a raw URL while it still names this exact immutable image. */
export function imageUrlForToken(tabId: string, token: string): string {
  const cache = imageCaches.get(tabId);
  const image = cache?.images.get(token);
  return image?.source && cache!.aliases.get(image.source.url) === token ? image.source.url : token;
}
export function imageSourceReferences(tabId: string): UrlRewrite[] {
  return getPendingImages(tabId).flatMap((image) =>
    image.source ? [{ placeholder: image.placeholder, relativePath: image.source.url }] : [],
  );
}
export function imagePreviewUrl(tabId: string, url: string): string {
  const cache = imageCaches.get(tabId);
  const image = cache?.images.get(url) ?? cache?.images.get(cache.aliases.get(url) ?? '');
  return image?.backing.previewUrl ?? url;
}
/** Images the full stash could not admit: saved and protected from their files, without a preview. */
export function unstashedImageCount(tabId: string): number {
  let count = 0;
  for (const image of imageCaches.get(tabId)?.images.values() ?? [])
    if (image.backing.key === null) count += 1;
  return count;
}
/**
 * An image left in its file owns no bytes and never enters editor history, so it is
 * forgotten, with its aliases, as soon as it is not among the tokens still in use.
 */
export function dropFileImages(cache: ImageCache, inUse: ReadonlySet<string>): boolean {
  let dropped = false;
  for (const [token, image] of cache.images) {
    if (image.backing.key !== null || inUse.has(token)) continue;
    cache.images.delete(token);
    for (const [url, owner] of cache.aliases) if (owner === token) cache.aliases.delete(url);
    quietlyRelease(image.backing);
    dropped = true;
  }
  return dropped;
}
/** Diagnostics expose byte counts, not image contents. Encoded bytes live only in native stash. */
export function imageCacheUsage(): { residentBytes: number; images: number } {
  return {
    residentBytes: 0,
    images: [...imageCaches.values()].reduce((count, cache) => count + cache.images.size, 0),
  };
}
