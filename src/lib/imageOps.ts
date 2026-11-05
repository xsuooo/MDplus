import { invoke } from '@tauri-apps/api/core';
import { pathKey } from './pathIdentity';
import { join, dirname } from '@tauri-apps/api/path';
import {
  getImageUrls,
  isRelativeImageUrl,
  rewriteImageReferences,
  type PendingImageReference,
} from './imagePaths';
import { basename, readImageFile, type ImageReceipt } from './fileOps';

interface PendingImage extends PendingImageReference {
  filename: string;
  data: number[];
  preview: string;
  /**
   * 已在磁盘上的图片,记录它的引用与绝对路径;粘贴图片首次保存后也登记来源。
   * 保存回同一个目录时按原引用还原(既不复制也不改写路径);只有另存为到
   * 别的目录、原引用会失效时才复制进 assets。粘贴进来的新图没有这个字段。
   */
  source?: { url: string; absolutePath: string };
}

interface ImageCache {
  images: Map<string, PendingImage>;
  aliases: Map<string, string>;
  generation: number;
  docPath: string | null;
}
const imageCaches = new Map<string, ImageCache>();
const imageListeners = new Map<string, Set<() => void>>();

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

/** Preview-only subscription: never dispatches an editor transaction. */
export function subscribeImageSources(tabId: string, listener: () => void): () => void {
  let listeners = imageListeners.get(tabId);
  if (!listeners) {
    listeners = new Set();
    imageListeners.set(tabId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && imageListeners.get(tabId) === listeners) imageListeners.delete(tabId);
  };
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

function imageExtension(blob: Blob): string {
  const mime = blob.type.split(';', 1)[0].toLowerCase();
  return IMAGE_EXTENSIONS[mime] ?? 'bin';
}

function imageId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function imageFilename(extension: string): string {
  return `image-${imageId()}.${extension}`;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

/** 将字节数组编码为 data URL(分块编码,避免大数组展开导致栈溢出)。 */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function rememberPendingImage(tabId: string, image: PendingImage): void {
  const cache = cacheFor(tabId);
  cache.images.set(image.placeholder, image);
  if (image.source) cache.aliases.set(image.source.url, image.placeholder);
  changed(tabId, cache);
}

export function getPendingImages(tabId: string): PendingImage[] {
  const cache = imageCaches.get(tabId);
  if (!cache) return [];
  return [...cache.images.values()].map((image) => {
    // A retired token still owns its immutable bytes, but its old disk URL may
    // now refer to another image. Undo must copy those bytes rather than reuse it.
    if (image.source && cache.aliases.get(image.source.url) !== image.placeholder) {
      return { ...image, source: undefined };
    }
    return image;
  });
}

export function restorePendingImages(
  tabId: string,
  images: {
    placeholder: string;
    filename: string;
    data: number[];
    mime: string;
  }[],
): void {
  const cache: ImageCache = { images: new Map(), aliases: new Map(), generation: 0, docPath: null };
  for (const image of images)
    cache.images.set(image.placeholder, {
      ...image,
      relativePath: `./assets/${image.filename}`,
      preview: bytesToDataUrl(new Uint8Array(image.data), image.mime),
    });
  imageCaches.set(tabId, cache);
  notifyImages(tabId);
}

export function clearPendingImages(tabId: string): void {
  imageCaches.delete(tabId);
  notifyImages(tabId);
}

export function resolveImageSource(tabId: string, url: string): string {
  const cache = imageCaches.get(tabId);
  const image = cache?.images.get(url) ?? cache?.images.get(cache.aliases.get(url) ?? '');
  return image?.preview ?? url;
}

interface ImageMigration {
  tabId: string;
  cache: ImageCache;
  targetFilePath: string;
  markdown: string;
  references: PendingImageReference[];
  updates: {
    image: PendingImage;
    filename: string;
    source: { url: string; absolutePath: string };
  }[];
}

/** 仅在文档写入成功后提交来源,失败的另存为不能改变后续迁移的基准目录。 */
export function commitImageMigration(migration: ImageMigration): void {
  const cache = imageCaches.get(migration.tabId);
  if (!cache || cache !== migration.cache) return;
  if (cache.docPath && !isSamePath(cache.docPath, migration.targetFilePath)) cache.aliases.clear();
  for (const { image, filename, source } of migration.updates) {
    const current = cache.images.get(image.placeholder);
    if (!current) continue;
    if (current.source && cache.aliases.get(current.source.url) === current.placeholder) {
      cache.aliases.delete(current.source.url);
    }
    cache.images.set(image.placeholder, { ...current, filename, relativePath: source.url, source });
    cache.aliases.set(source.url, image.placeholder);
  }
  cache.docPath = migration.targetFilePath;
  changed(migration.tabId, cache);
}

/**
 * 将某个未保存标签中的图片写入目标文档 assets 目录，并重写 Markdown 引用。
 * 图片字节保存在前端内存中，因此不依赖临时目录和跨磁盘 rename。
 */
export async function migratePendingImages(
  tabId: string,
  targetFilePath: string,
  markdown: string,
): Promise<ImageMigration> {
  const cache = cacheFor(tabId);
  const pending = getPendingImages(tabId);
  const context = { tabId, cache, targetFilePath };
  const updates: ImageMigration['updates'] = [];
  const urls = new Set(getImageUrls(markdown));
  const knownTokens = new Set(pending.map((image) => image.placeholder));
  for (const url of urls) {
    if (/^mdplus-image:/i.test(url) && !knownTokens.has(url)) {
      throw new Error(`图片数据已丢失,无法保存: ${url}`);
    }
  }
  if (pending.length === 0) return { ...context, markdown, updates, references: [] };

  const dir = await dirname(targetFilePath);

  const references: PendingImageReference[] = [];

  for (const image of pending) {
    const imageReferences = [image.placeholder, image.source?.url].filter(
      (url): url is string => !!url && urls.has(url),
    );
    if (imageReferences.length === 0) continue;

    // 磁盘上原有的图片:只要它相对新的保存位置仍然指向同一个文件,就把
    // 原引用原样写回。这既保住了作者自己的目录结构(如 ./img/pic.png),
    // 也避免了两张不同目录的同名图在 assets 里互相覆盖。
    if (image.source) {
      const resolved = await join(dir, image.source.url.replace(/^\.\//, ''));
      if (isSamePath(resolved, image.source.absolutePath)) {
        for (const reference of imageReferences) {
          references.push({ placeholder: reference, relativePath: image.source.url });
        }
        updates.push({ image, filename: image.filename, source: image.source });
        continue;
      }
    }

    // Allocate and write in one native operation; per-tab queues cannot protect a shared assets directory.
    const asset = await invoke<ImageReceipt>('save_image_asset', {
      docPath: targetFilePath,
      filename: image.filename,
      data: image.data,
    });
    for (const reference of imageReferences) {
      references.push({ placeholder: reference, relativePath: asset.relativePath });
    }
    updates.push({
      image,
      filename: asset.filename,
      source: { url: asset.relativePath, absolutePath: asset.path },
    });
  }

  return {
    ...context,
    markdown: rewriteImageReferences(markdown, references),
    updates,
    references,
  };
}

/**
 * 两个路径是否指向同一个文件。Windows 下大小写不敏感、两种分隔符等价,
 * 与文档打开／另存为共用 pathKey：统一点路径、大小写、分隔符和扩展前缀。
 * 此处比较的是已解析的绝对目标；相对文稿路径先交由原生命令解析。
 */
function isSamePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

export interface PreparedImageReferences {
  markdown: string;
  /** False means the tab/cache changed or this preparation was already consumed. */
  commit: () => boolean;
}

/**
 * Stage relative image reads without changing visible aliases, tokens or bytes.
 * The caller checks document generation/path/native revision before committing.
 * Only the per-tab lifetime record is reserved here, so closing an empty tab can
 * invalidate an outstanding read. Source Markdown is always returned verbatim.
 */
export async function prepareImageReferences(
  tabId: string,
  markdown: string,
  docPath: string,
  options: { refresh?: boolean } = {},
): Promise<PreparedImageReferences> {
  const cache = cacheFor(tabId);
  const generation = cache.generation;
  const aliases = new Map(cache.aliases);
  const images = new Map(cache.images);
  const sameDocument = cache.docPath !== null && isSamePath(cache.docPath, docPath);
  const staged = new Map<string, PendingImage | null>();
  for (const url of new Set(getImageUrls(markdown))) {
    if (!isRelativeImageUrl(url)) continue;
    const existing = images.get(aliases.get(url) ?? '');
    if (sameDocument && existing && !options.refresh) continue;
    const relativePath = url.replace(/^\.\//, '');
    try {
      const image = await readImageFile(docPath, relativePath);
      const preview = bytesToDataUrl(new Uint8Array(image.data), image.mime);
      if (
        existing?.source &&
        isSamePath(existing.source.absolutePath, image.path) &&
        existing.preview === preview
      ) {
        staged.set(url, existing);
      } else {
        const placeholder = `mdplus-image:${imageId()}`;
        staged.set(url, {
          placeholder,
          preview,
          relativePath: url,
          filename: basename(relativePath),
          data: image.data,
          source: { url, absolutePath: image.path },
        });
      }
    } catch {
      // Failure is also a staged observation. Do not keep serving an obsolete
      // live URL after commit, but keep its immutable token available for undo.
      staged.set(url, null);
    }
  }
  let consumed = false;
  return {
    markdown,
    commit: () => {
      if (consumed || imageCaches.get(tabId) !== cache || cache.generation !== generation)
        return false;
      consumed = true;
      let visibleChange = false;
      if (!sameDocument && cache.docPath !== null) {
        visibleChange = cache.aliases.size > 0;
        cache.aliases.clear();
      }
      for (const [url, image] of staged) {
        if (image) {
          visibleChange ||= cache.aliases.get(url) !== image.placeholder;
          cache.images.set(image.placeholder, image);
          cache.aliases.set(url, image.placeholder);
        } else {
          visibleChange = cache.aliases.delete(url) || visibleChange;
        }
      }
      cache.docPath = docPath;
      // Even an identical winning read must invalidate older pending results.
      changed(tabId, cache, visibleChange);
      return true;
    },
  };
}

/** First-open convenience: publish a checked cache, then tokenize only image URLs. */
export async function loadImageReferences(
  tabId: string,
  markdown: string,
  docPath: string,
): Promise<string> {
  const prepared = await prepareImageReferences(tabId, markdown, docPath, { refresh: true });
  if (!prepared.commit()) throw new Error('图片缓存已在加载期间改变，请重新打开文档');
  const cache = imageCaches.get(tabId)!;
  const references = [...new Set(getImageUrls(markdown))].flatMap((url) => {
    const token = cache.aliases.get(url);
    return token ? [{ placeholder: url, relativePath: token }] : [];
  });
  return rewriteImageReferences(markdown, references);
}

/** 粘贴图片:返回短 token,显示数据留在缓存,保存/另存为统一迁移。 */
export async function saveImage(blob: Blob, tabId: string): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const data = new Uint8Array(buffer);
  const extension = imageExtension(blob);
  const filename = imageFilename(extension);
  const preview = await blobToDataUrl(blob);
  const placeholder = `mdplus-image:${imageId()}`;
  rememberPendingImage(tabId, {
    placeholder,
    preview,
    relativePath: `./assets/${filename}`,
    filename,
    data: Array.from(data),
  });
  return placeholder;
}
