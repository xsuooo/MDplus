/** Pinning pending images across async work (capture) and staging them for recovery restore. */
import { invoke } from '@tauri-apps/api/core';
import {
  type PendingImage,
  type PendingImageFile,
  type ImageBacking,
  type CachedImage,
  type ImageCache,
  imageCaches,
  imageIO,
  notifyImages,
  imageReferencesChanged,
  releaseBacking,
  quietlyRelease,
  snapshotImage,
} from './cache';
import { imageByteLength, stashImage, readFileBacking } from './stash';

export interface PendingImageLease {
  images: PendingImage[];
  readDataBase64: (placeholder: string) => Promise<string>;
  /** Only for an image held by the stash; an image left in its file rejects. */
  withStashKey: <T>(placeholder: string, consume: (stashKey: string) => Promise<T>) => Promise<T>;
  /** Only for an image left in its file (`PendingImage.file`); a stashed image rejects. */
  withFile: <T>(placeholder: string, consume: (file: PendingImageFile) => Promise<T>) => Promise<T>;
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
  const withBacking = <T>(placeholder: string, consume: (backing: ImageBacking) => Promise<T>) => {
    const backing = backings.get(placeholder);
    if (released || !backing) return Promise.reject(new Error('图片读取租约已释放或身份不匹配'));
    // An operation keeps its own pin even if its caller cancels/releases while queued.
    backing.owners += 1;
    return imageIO(async () => {
      try {
        return await consume(backing);
      } finally {
        await releaseBacking(backing);
      }
    });
  };
  const withDataBase64 = <T>(placeholder: string, consume: (dataBase64: string) => Promise<T>) =>
    withBacking(placeholder, async (backing) => {
      if (backing.key === null) return consume(await readFileBacking(backing));
      const data = await invoke<{ dataBase64: string; mime: string }>('read_stashed_image', {
        key: backing.key,
      });
      if (imageByteLength(data.dataBase64) !== backing.byteLength)
        throw new Error('图片暂存数据已损坏');
      return consume(data.dataBase64);
    });
  return {
    images: selected.map((image) => snapshotImage(cache!, image)),
    withStashKey: (placeholder, consume) =>
      withBacking(placeholder, (backing) =>
        backing.key === null
          ? Promise.reject(new Error('图片未进入暂存区，无法按暂存键读取'))
          : consume(backing.key),
      ),
    // The file is read from the backing, not from `images`: Save As may have moved it since.
    withFile: (placeholder, consume) =>
      withBacking(placeholder, (backing) =>
        backing.key === null
          ? consume({ ...backing.file, digest: backing.digest })
          : Promise.reject(new Error('图片已在暂存区，无法按文件读取')),
      ),
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
export const restoredStages = new WeakMap<
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
