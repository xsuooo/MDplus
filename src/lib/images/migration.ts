/** Moving pending images into the document assets folder as part of a save. */
import { invoke } from '@tauri-apps/api/core';
import { join, dirname } from '@tauri-apps/api/path';
import { getImageUrls, rewriteImageReferences, type UrlRewrite } from '../imagePaths';
import { type ImageReceipt } from '../fileOps';
import {
  type PendingImage,
  type ImageCache,
  imageCaches,
  cacheFor,
  changed,
  imageIdentityReferences,
  dropFileImages,
} from './cache';
import { type PendingImageLease, capturePendingImages } from './lease';
import { isSamePath, relativeImageFilePath, imageFilePathUrl } from './stash';

export interface ImageMigration {
  tabId: string;
  cache: ImageCache;
  targetFilePath: string;
  markdown: string;
  references: UrlRewrite[];
  historyReferences: UrlRewrite[];
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
    // The copy just written was checked against the digest, so it is the same image.
    if (current.backing.key === null)
      current.backing.file = {
        docPath: migration.targetFilePath,
        relativePath: relativeImageFilePath(source.url),
      };
    cache.images.set(image.placeholder, { ...current, filename, relativePath: source.url, source });
    cache.aliases.set(source.url, image.placeholder);
  }
  dropFileImages(cache, new Set(cache.aliases.values()));
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
        const resolved = await join(dir, relativeImageFilePath(image.source.url));
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
      const relativePath = imageFilePathUrl(asset.relativePath);
      for (const placeholder of references)
        migration.references.push({ placeholder, relativePath });
      migration.updates.push({
        image,
        filename: asset.filename,
        source: { url: relativePath, absolutePath: asset.path },
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
