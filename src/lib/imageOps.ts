import { invoke } from '@tauri-apps/api/core';
import { join, dirname } from '@tauri-apps/api/path';
import { LIMITS } from '../config/constants';
import { pathKey } from './pathIdentity';
import {
  getImageUrls,
  isRelativeImageUrl,
  rewriteImageReferences,
  type PendingImageReference,
} from './imagePaths';
import { basename, readImageFile, type ImageReceipt } from './fileOps';

/** Public snapshots contain identities, never a second copy of the image bytes. */
export interface PendingImage extends PendingImageReference {
  filename: string;
  mime: string;
  byteLength: number;
  source?: { url: string; absolutePath: string };
}
interface ImageBacking {
  key: string;
  mime: string;
  byteLength: number;
  digest: string;
  owners: number;
  /** A process-owned, read-only native URL, not a retained JS binary/data URL. */
  previewUrl: string;
}
interface CachedImage extends PendingImage {
  backing: ImageBacking;
  inserting?: boolean;
}
interface ImageCache {
  images: Map<string, CachedImage>;
  aliases: Map<string, string>;
  generation: number;
  docPath: string | null;
}
const imageCaches = new Map<string, ImageCache>();
const imageListeners = new Map<string, Set<() => void>>();
const imageRoots = new Map<string, Set<() => Iterable<string>>>();
const collectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Serialize complete read/encode/write operations, not just individual invokes:
// otherwise many tabs can keep a 64 MiB base64 result alive while queued to write.
let imageIOTail: Promise<unknown> = Promise.resolve();
function imageIO<T>(operation: () => Promise<T>): Promise<T> {
  const next = imageIOTail.catch(() => {}).then(operation);
  imageIOTail = next.catch(() => {});
  return next;
}
function cacheFor(tabId: string): ImageCache {
  let cache = imageCaches.get(tabId);
  if (!cache) {
    cache = { images: new Map(), aliases: new Map(), generation: 0, docPath: null };
    imageCaches.set(tabId, cache);
  }
  return cache;
}
function notifyImages(tabId: string): void {
  for (const listener of [...(imageListeners.get(tabId) ?? [])]) {
    try {
      listener();
    } catch (error) {
      console.error('图片预览刷新失败', error);
    }
  }
}
function changed(tabId: string, cache: ImageCache, notify = true): void {
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
async function releaseBacking(backing: ImageBacking): Promise<void> {
  if (--backing.owners > 0) return;
  await invoke('discard_stashed_images', { keys: [backing.key] });
}
function quietlyRelease(backing: ImageBacking): void {
  void releaseBacking(backing).catch((error) => console.error('释放图片暂存失败', error));
}
/** Reclaim only images proven unreachable by every live editor and capture lease. */
export async function collectUnusedImages(tabId?: string): Promise<void> {
  const discarded: Promise<void>[] = [];
  for (const [id, cache] of imageCaches) {
    if (tabId !== undefined && tabId !== id) continue;
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
    for (const [token, image] of cache.images) {
      if (image.inserting || image.backing.owners > 1 || reachable.has(token)) continue;
      removed = true;
      cache.images.delete(token);
      for (const [url, owner] of cache.aliases) if (owner === token) cache.aliases.delete(url);
      discarded.push(releaseBacking(image.backing));
    }
    if (removed) changed(id, cache, false);
  }
  await Promise.all(discarded);
}
/** Call after insertion, or after a paste is rejected by its generation check. */
export function settleImageInsertion(tabId: string, placeholder: string): void {
  const image = imageCaches.get(tabId)?.images.get(placeholder);
  if (image) image.inserting = false;
  imageReferencesChanged(tabId);
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};
function imageId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function imageByteLength(dataBase64: string): number {
  if (typeof dataBase64 !== 'string' || dataBase64.length % 4 !== 0)
    throw new Error('图片编码无效');
  const length =
    (dataBase64.length / 4) * 3 -
    (dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0);
  if (length <= 0 || length > LIMITS.imageFileBytes) throw new Error('图片为空或超过 64 MiB 限制');
  return length;
}
function decodeImage(dataBase64: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(imageByteLength(dataBase64));
  // Avoid a second, image-sized binary JS string from atob.
  let offset = 0;
  for (let from = 0; from < dataBase64.length; from += 0x8000) {
    const binary = atob(dataBase64.slice(from, from + 0x8000));
    for (let i = 0; i < binary.length; i++) bytes[offset++] = binary.charCodeAt(i);
  }
  if (offset !== bytes.byteLength) throw new Error('图片编码无效');
  return bytes;
}
function encodeImage(bytes: Uint8Array): string {
  const chunks: string[] = [];
  // Multiple of three: only the last independently encoded block has padding.
  for (let offset = 0; offset < bytes.length; offset += 0x6000)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 0x6000))));
  return chunks.join('');
}
async function digestImage(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function stashImage(
  filename: string,
  dataBase64: string,
  existing?: ImageBacking,
): Promise<ImageBacking> {
  const byteLength = imageByteLength(dataBase64);
  // At most one transfer/hash operation runs globally. No persistent image bytes
  // remain in JS: two raw-size working buffers fit the configured 128 MiB budget,
  // while the compact base64 IPC string is itself bounded by the 64 MiB limit.
  if (byteLength * 2 > LIMITS.imageMemoryBytes) throw new Error('图片传输内存预算不足');
  const digest = await digestImage(decodeImage(dataBase64));
  if (existing?.digest === digest && existing.owners > 0) {
    existing.owners += 1;
    return existing;
  }
  const stashed = await invoke<{ key: string; mime: string; previewUrl: string }>('stash_image', {
    filename,
    dataBase64,
  });
  return {
    key: stashed.key,
    mime: stashed.mime,
    previewUrl: stashed.previewUrl,
    byteLength,
    digest,
    owners: 1,
  };
}
function snapshotImage(cache: ImageCache, image: CachedImage): PendingImage {
  const { placeholder, relativePath, filename, mime, byteLength } = image;
  // A retired token owns its immutable stash, never somebody else's current disk URL.
  const source =
    image.source && cache.aliases.get(image.source.url) === placeholder
      ? { ...image.source }
      : undefined;
  return { placeholder, relativePath, filename, mime, byteLength, source };
}
export function getPendingImages(tabId: string): PendingImage[] {
  const cache = imageCaches.get(tabId);
  return cache ? [...cache.images.values()].map((image) => snapshotImage(cache, image)) : [];
}
export interface PendingImageLease {
  images: PendingImage[];
  readDataBase64: (placeholder: string) => Promise<string>;
  withDataBase64: <T>(
    placeholder: string,
    consume: (dataBase64: string) => Promise<T>,
  ) => Promise<T>;
  release: () => void;
}
/** Freeze aliases synchronously and pin disk bytes across debounce, close and GC. */
export function capturePendingImages(tabId: string, urls?: Iterable<string>): PendingImageLease {
  const cache = imageCaches.get(tabId);
  const wanted = urls === undefined ? undefined : new Set(urls);
  const selected = (cache ? [...cache.images.values()] : []).filter(
    (image) =>
      !wanted ||
      wanted.has(image.placeholder) ||
      (image.source &&
        cache!.aliases.get(image.source.url) === image.placeholder &&
        wanted.has(image.source.url)),
  );
  const backings = new Map(selected.map((image) => [image.placeholder, image.backing]));
  for (const backing of backings.values()) backing.owners += 1;
  let released = false;
  const withDataBase64 = <T>(placeholder: string, consume: (dataBase64: string) => Promise<T>) => {
    const backing = backings.get(placeholder);
    if (released || !backing) return Promise.reject(new Error('图片读取租约已释放或身份不匹配'));
    // An operation keeps its own pin even if its caller cancels/releases while queued.
    backing.owners += 1;
    return imageIO(async () => {
      try {
        const data = await invoke<{ dataBase64: string; mime: string }>('read_stashed_image', {
          key: backing.key,
        });
        if (imageByteLength(data.dataBase64) !== backing.byteLength)
          throw new Error('图片暂存数据已损坏');
        return await consume(data.dataBase64);
      } finally {
        await releaseBacking(backing);
      }
    });
  };
  return {
    images: selected.map((image) => snapshotImage(cache!, image)),
    withDataBase64,
    readDataBase64: (placeholder) => withDataBase64(placeholder, async (data) => data),
    release: () => {
      if (released) return;
      released = true;
      for (const backing of backings.values()) quietlyRelease(backing);
      imageReferencesChanged(tabId);
    },
  };
}

export interface StagedPendingImages {
  dispose: () => Promise<void>;
}
const restoredStages = new WeakMap<
  StagedPendingImages,
  { images: CachedImage[]; consumed: boolean }
>();
/** Stage outside the recovery commit; no partially decoded cache can become visible. */
export async function stagePendingImages(
  images: { placeholder: string; filename: string; dataBase64: string; mime: string }[],
): Promise<StagedPendingImages> {
  const state = { images: [] as CachedImage[], consumed: false };
  const stage: StagedPendingImages = {
    dispose: async () => {
      if (state.consumed) return;
      state.consumed = true;
      await Promise.all(state.images.map((image) => releaseBacking(image.backing)));
    },
  };
  restoredStages.set(stage, state);
  try {
    const tokens = new Set<string>();
    for (const image of images) {
      if (!/^mdplus-image:[\w-]+$/i.test(image.placeholder) || tokens.has(image.placeholder))
        throw new Error('恢复图片身份无效或重复');
      tokens.add(image.placeholder);
      const backing = await imageIO(() => stashImage(image.filename, image.dataBase64));
      state.images.push({
        placeholder: image.placeholder,
        filename: image.filename,
        relativePath: `./assets/${image.filename}`,
        mime: backing.mime,
        byteLength: backing.byteLength,
        backing,
      });
    }
    return stage;
  } catch (error) {
    await stage.dispose();
    throw error;
  }
}
/** Synchronous and atomic: the caller publishes its tab in the same turn. */
export function restorePendingImages(tabId: string, stage: StagedPendingImages): void {
  const state = restoredStages.get(stage);
  if (!state || state.consumed) throw new Error('恢复图片准备已失效');
  const cache: ImageCache = {
    images: new Map(state.images.map((image) => [image.placeholder, image])),
    aliases: new Map(),
    generation: 0,
    docPath: null,
  };
  const previous = imageCaches.get(tabId);
  state.consumed = true;
  imageCaches.set(tabId, cache);
  if (previous) for (const image of previous.images.values()) quietlyRelease(image.backing);
  notifyImages(tabId);
}
export function clearPendingImages(tabId: string): void {
  const cache = imageCaches.get(tabId);
  imageCaches.delete(tabId);
  clearTimeout(collectionTimers.get(tabId));
  collectionTimers.delete(tabId);
  if (cache) for (const image of cache.images.values()) quietlyRelease(image.backing);
  notifyImages(tabId);
}
/** Canonical identities for editor history; source text itself need not be rewritten. */
export function imageIdentityReferences(tabId: string): PendingImageReference[] {
  return [...(imageCaches.get(tabId)?.aliases ?? [])].map(([url, token]) => ({
    placeholder: url,
    relativePath: token,
  }));
}
export function resolveImageIdentity(tabId: string, url: string): string {
  return imageCaches.get(tabId)?.aliases.get(url) ?? url;
}
/** Only expose a raw URL while it still names this exact immutable image. */
export function resolveImageReference(tabId: string, token: string): string {
  const cache = imageCaches.get(tabId);
  const image = cache?.images.get(token);
  return image?.source && cache!.aliases.get(image.source.url) === token ? image.source.url : token;
}
export function imageSourceReferences(tabId: string): PendingImageReference[] {
  return getPendingImages(tabId).flatMap((image) =>
    image.source ? [{ placeholder: image.placeholder, relativePath: image.source.url }] : [],
  );
}
export function resolveImageSource(tabId: string, url: string): string {
  const cache = imageCaches.get(tabId);
  const image = cache?.images.get(url) ?? cache?.images.get(cache.aliases.get(url) ?? '');
  return image?.backing.previewUrl ?? url;
}
/** Diagnostics expose byte counts, not image contents. Encoded bytes live only in native stash. */
export function imageCacheUsage(): { residentBytes: number; images: number } {
  return {
    residentBytes: 0,
    images: [...imageCaches.values()].reduce((count, cache) => count + cache.images.size, 0),
  };
}

export interface ImageMigration {
  tabId: string;
  cache: ImageCache;
  targetFilePath: string;
  markdown: string;
  references: PendingImageReference[];
  historyReferences: PendingImageReference[];
  allocationIds: string[];
  updates: {
    image: PendingImage;
    filename: string;
    source: { url: string; absolutePath: string };
  }[];
}
const migrationLeases = new WeakMap<ImageMigration, PendingImageLease>();
function releaseMigration(migration: ImageMigration): void {
  migrationLeases.get(migration)?.release();
  migrationLeases.delete(migration);
}
/** Native ownership and visible cache adoption are deliberately separate decisions. */
export async function finalizeImageMigration(
  migration: ImageMigration,
  state: 'unchanged' | 'committed' | 'unknown',
): Promise<void> {
  try {
    if (!migration.allocationIds.length) return;
    const allocationIds = migration.allocationIds.splice(0);
    await invoke(state === 'unchanged' ? 'discard_image_assets' : 'commit_image_assets', {
      allocationIds,
    });
  } finally {
    releaseMigration(migration);
  }
}
/** Adopt only after a successful document write and an unchanged document generation. */
export function commitImageMigration(migration: ImageMigration): void {
  const cache = imageCaches.get(migration.tabId);
  if (!cache || cache !== migration.cache) return;
  if (cache.docPath && !isSamePath(cache.docPath, migration.targetFilePath)) cache.aliases.clear();
  for (const { image, filename, source } of migration.updates) {
    const current = cache.images.get(image.placeholder);
    if (!current) continue;
    if (current.source && cache.aliases.get(current.source.url) === current.placeholder)
      cache.aliases.delete(current.source.url);
    cache.images.set(image.placeholder, { ...current, filename, relativePath: source.url, source });
    cache.aliases.set(source.url, image.placeholder);
  }
  cache.docPath = migration.targetFilePath;
  changed(migration.tabId, cache);
  releaseMigration(migration);
}
/** Assets are provisional until finalize observes the document's actual write state. */
export async function migratePendingImages(
  tabId: string,
  targetFilePath: string,
  markdown: string,
): Promise<ImageMigration> {
  const cache = cacheFor(tabId);
  const urls = new Set(getImageUrls(markdown));
  const lease = capturePendingImages(tabId, urls);
  const migration: ImageMigration = {
    tabId,
    cache,
    targetFilePath,
    markdown,
    updates: [],
    references: [],
    historyReferences: imageIdentityReferences(tabId),
    allocationIds: [],
  };
  migrationLeases.set(migration, lease);
  try {
    const knownTokens = new Set(lease.images.map((image) => image.placeholder));
    for (const url of urls) {
      if (/^mdplus-image:/i.test(url) && !knownTokens.has(url))
        throw new Error(`图片数据已丢失,无法保存: ${url}`);
    }
    if (!lease.images.length) return migration;
    const dir = await dirname(targetFilePath);
    for (const image of lease.images) {
      const references = [image.placeholder, image.source?.url].filter(
        (url): url is string => !!url && urls.has(url),
      );
      if (image.source) {
        const resolved = await join(dir, image.source.url.replace(/^\.\//, ''));
        if (isSamePath(resolved, image.source.absolutePath)) {
          for (const placeholder of references)
            migration.references.push({ placeholder, relativePath: image.source.url });
          migration.updates.push({ image, filename: image.filename, source: image.source });
          continue;
        }
      }
      const asset = await lease.withDataBase64(image.placeholder, (dataBase64) =>
        invoke<ImageReceipt & { allocationId: string | null }>('save_image_asset', {
          docPath: targetFilePath,
          filename: image.filename,
          dataBase64,
        }),
      );
      if (asset.allocationId) migration.allocationIds.push(asset.allocationId);
      for (const placeholder of references)
        migration.references.push({ placeholder, relativePath: asset.relativePath });
      migration.updates.push({
        image,
        filename: asset.filename,
        source: { url: asset.relativePath, absolutePath: asset.path },
      });
    }
    migration.markdown = rewriteImageReferences(markdown, migration.references);
    return migration;
  } catch (error) {
    try {
      await finalizeImageMigration(migration, 'unchanged');
    } catch (cleanup) {
      console.error('未提交的图片资产清理失败', cleanup);
    }
    throw error;
  }
}
function isSamePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}
export interface PreparedImageReferences {
  markdown: string;
  commit: () => boolean;
  dispose: () => Promise<void>;
}
/** Reads and stashes are staged; aliases are published only by a winning commit. */
export async function prepareImageReferences(
  tabId: string,
  markdown: string,
  docPath: string,
  options: { refresh?: boolean } = {},
): Promise<PreparedImageReferences> {
  const cache = cacheFor(tabId);
  await collectUnusedImages();
  const generation = cache.generation;
  const sameDocument = cache.docPath !== null && isSamePath(cache.docPath, docPath);
  const staged = new Map<string, CachedImage | null>();
  let consumed = false;
  const dispose = async () => {
    if (consumed) return;
    consumed = true;
    await Promise.all(
      [...staged.values()].flatMap((image) => (image ? [releaseBacking(image.backing)] : [])),
    );
  };
  try {
    for (const url of new Set(getImageUrls(markdown))) {
      if (!isRelativeImageUrl(url)) continue;
      const existing = cache.images.get(cache.aliases.get(url) ?? '');
      if (sameDocument && existing && !options.refresh) continue;
      const relativePath = url.replace(/^\.\//, '');
      // Missing/invalid source observations may retire a live alias. A stash-full
      // error, however, must reject the preparation rather than retire good data.
      const image = await imageIO(async () => {
        let loaded: Awaited<ReturnType<typeof readImageFile>>;
        try {
          loaded = await readImageFile(docPath, relativePath);
        } catch {
          return null;
        }
        const reusable = existing?.source && isSamePath(existing.source.absolutePath, loaded.path);
        const backing = await stashImage(
          basename(relativePath),
          loaded.dataBase64,
          reusable ? existing.backing : undefined,
        );
        const placeholder =
          backing === existing?.backing ? existing.placeholder : `mdplus-image:${imageId()}`;
        return {
          placeholder,
          filename: basename(relativePath),
          relativePath: url,
          mime: backing.mime,
          byteLength: backing.byteLength,
          source: { url, absolutePath: loaded.path },
          backing,
        };
      });
      staged.set(url, image);
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    markdown,
    dispose,
    commit: () => {
      if (consumed || imageCaches.get(tabId) !== cache || cache.generation !== generation) {
        void dispose().catch((error) => console.error('释放过期图片准备失败', error));
        return false;
      }
      consumed = true;
      let visibleChange = false;
      if (!sameDocument && cache.docPath !== null) {
        visibleChange = cache.aliases.size > 0;
        cache.aliases.clear();
      }
      for (const [url, image] of staged) {
        if (image) {
          visibleChange ||= cache.aliases.get(url) !== image.placeholder;
          const previous = cache.images.get(image.placeholder);
          cache.images.set(image.placeholder, image);
          cache.aliases.set(url, image.placeholder);
          if (previous) quietlyRelease(previous.backing);
        } else visibleChange = cache.aliases.delete(url) || visibleChange;
      }
      cache.docPath = docPath;
      changed(tabId, cache, visibleChange);
      return true;
    },
  };
}
/** First-open adapter used by integrations that explicitly want compact tokens. */
export async function loadImageReferences(
  tabId: string,
  markdown: string,
  docPath: string,
): Promise<string> {
  const prepared = await prepareImageReferences(tabId, markdown, docPath, { refresh: true });
  if (!prepared.commit()) throw new Error('图片缓存已在加载期间改变，请重新打开文档');
  return rewriteImageReferences(markdown, imageIdentityReferences(tabId));
}
/** Stash before publishing: bounded memory never discards the only copy of a paste. */
export async function saveImage(blob: Blob, tabId: string): Promise<string> {
  if (!blob.size || blob.size > LIMITS.imageFileBytes)
    throw new Error('图片为空或超过 64 MiB 限制');
  const cache = cacheFor(tabId);
  const mime = blob.type.split(';', 1)[0].toLowerCase();
  const filename = `image-${imageId()}.${IMAGE_EXTENSIONS[mime] ?? 'bin'}`;
  await collectUnusedImages();
  const backing = await imageIO(async () =>
    stashImage(filename, encodeImage(new Uint8Array(await blob.arrayBuffer()))),
  );
  if (imageCaches.get(tabId) !== cache) {
    await releaseBacking(backing);
    throw new Error('标签已关闭，图片粘贴已取消');
  }
  const placeholder = `mdplus-image:${imageId()}`;
  cache.images.set(placeholder, {
    placeholder,
    filename,
    relativePath: `./assets/${filename}`,
    mime: backing.mime,
    byteLength: backing.byteLength,
    backing,
    inserting: true,
  });
  changed(tabId, cache);
  return placeholder;
}
