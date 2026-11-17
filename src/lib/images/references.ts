/** Turning image URLs in a document into cached images: on open, paste and drop. */
import { invoke } from '@tauri-apps/api/core';
import { LIMITS } from '../../config/constants';
import { pathKey } from '../paths';
import { getImageUrls, isRelativeImageUrl, rewriteImageReferences } from '../imagePaths';
import { basename, readImageFile } from '../fileOps';
import {
  type ImageBacking,
  type CachedImage,
  imageCaches,
  imageIO,
  cacheFor,
  changed,
  releaseBacking,
  quietlyRelease,
  collectUnusedImages,
  imageIdentityReferences,
  dropFileImages,
} from './cache';
import { IMAGE_EXTENSIONS, imageId, encodeImage, stashImage } from './stash';

export function isSamePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Decode Markdown URLs once; native validation still owns filesystem boundaries. */
export function relativeImageFilePath(url: string): string {
  let path = url;
  try {
    path = decodeURIComponent(url);
  } catch {
    // Existing documents can use a literal, malformed percent escape in a filename.
  }
  return path.replace(/^\.\//, '');
}

/** Native receipts contain filesystem paths, whose percent/hash characters are literal. */
export function imageFilePathUrl(path: string): string {
  return path.replace(/[%#?]/g, (character) => encodeURIComponent(character));
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
      // An image left in its file is read again by every preparation: that retries
      // its admission and keeps the recorded digest in step with the file.
      if (sameDocument && existing && existing.backing.key !== null && !options.refresh) continue;
      const relativePath = relativeImageFilePath(url);
      // Missing/invalid source observations may retire a live alias. A stash failure
      // must reject the preparation rather than retire good data, with one exception:
      // outside a refresh, a full stash leaves the image in its file (see stashImage).
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
          options.refresh ? undefined : { docPath, relativePath, mime: loaded.mime },
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
      const stagedTokens = new Set<string>();
      for (const [url, image] of staged) {
        if (image) {
          stagedTokens.add(image.placeholder);
          visibleChange ||= cache.aliases.get(url) !== image.placeholder;
          const previous = cache.images.get(image.placeholder);
          cache.images.set(image.placeholder, image);
          cache.aliases.set(url, image.placeholder);
          if (previous) quietlyRelease(previous.backing);
        } else visibleChange = cache.aliases.delete(url) || visibleChange;
      }
      // Each image left in its file is staged again whenever the text still references
      // it, so one this preparation did not stage has left the document.
      const dropped = dropFileImages(cache, stagedTokens);
      cache.docPath = docPath;
      changed(tabId, cache, visibleChange || dropped);
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

export interface DroppedImageReceipt {
  key: string;
  mime: 'image/png' | 'image/jpeg';
  previewUrl: string;
  filename: string;
  byteLength: number;
  digest: string;
}

/** An explicit drop command validates/decodes a regular PNG/JPEG and directly
 * stashes the unchanged native bytes. JS retains only its immutable identity. */
export async function importDroppedImage(path: string, tabId: string): Promise<string> {
  const cache = cacheFor(tabId);
  await collectUnusedImages();
  const receipt = await imageIO(() =>
    invoke<DroppedImageReceipt>('import_dropped_image', { path }),
  );
  const backing: ImageBacking = {
    key: receipt.key,
    mime: receipt.mime,
    byteLength: receipt.byteLength,
    digest: receipt.digest,
    previewUrl: receipt.previewUrl,
    owners: 1,
  };
  try {
    if (
      !/^[0-9a-f]{32}$/.test(receipt.key) ||
      !/^[0-9a-f]{64}$/.test(receipt.digest) ||
      !Number.isSafeInteger(receipt.byteLength) ||
      receipt.byteLength <= 0 ||
      receipt.byteLength > LIMITS.imageFileBytes ||
      !receipt.previewUrl ||
      !receipt.filename ||
      /[\\/]/.test(receipt.filename) ||
      !/\.(png|jpe?g)$/i.test(receipt.filename) ||
      (receipt.mime !== 'image/png' && receipt.mime !== 'image/jpeg')
    )
      throw new Error('原生图片导入结果无效');
    if (imageCaches.get(tabId) !== cache) throw new Error('标签已关闭，图片拖入已取消');
    const placeholder = `mdplus-image:${imageId()}`;
    cache.images.set(placeholder, {
      placeholder,
      filename: receipt.filename,
      relativePath: `./assets/${receipt.filename}`,
      mime: backing.mime,
      byteLength: backing.byteLength,
      backing,
      inserting: true,
    });
    changed(tabId, cache);
    return placeholder;
  } catch (error) {
    await releaseBacking(backing);
    throw error;
  }
}
