import { invoke } from '@tauri-apps/api/core';
import { join, dirname } from '@tauri-apps/api/path';
import { getImageUrls, rewriteImageReferences, type PendingImageReference } from './imagePaths';
import { basename, fileMtime, readImageFile } from './fileOps';

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

const pendingImages = new Map<string, PendingImage[]>();

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

function isExternalUrl(url: string): boolean {
  return /^(?:mdplus-image:|https?:|data:|file:|[a-zA-Z]:[\\/]|\/|\/\/)/.test(url);
}

function rememberPendingImage(tabId: string, image: PendingImage): void {
  const images = pendingImages.get(tabId) ?? [];
  images.push(image);
  pendingImages.set(tabId, images);
}

function getPendingImages(tabId: string): PendingImage[] {
  return [...(pendingImages.get(tabId) ?? [])];
}

export function clearPendingImages(tabId: string): void {
  pendingImages.delete(tabId);
}

export function resolveImageSource(tabId: string, url: string): string {
  const image = pendingImages.get(tabId)?.find((item) => item.placeholder === url || item.source?.url === url);
  return image?.preview ?? url;
}

interface ImageMigration {
  markdown: string;
  updates: { image: PendingImage; filename: string; source: { url: string; absolutePath: string } }[];
}

/** 仅在文档写入成功后提交来源,失败的另存为不能改变后续迁移的基准目录。 */
export function commitImageMigration(migration: ImageMigration): void {
  for (const { image, filename, source } of migration.updates) {
    image.filename = filename;
    image.relativePath = source.url;
    image.source = source;
  }
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
  const pending = getPendingImages(tabId);
  const updates: ImageMigration['updates'] = [];
  const urls = new Set(getImageUrls(markdown));
  const knownTokens = new Set(pending.map((image) => image.placeholder));
  for (const url of urls) {
    if (/^mdplus-image:/i.test(url) && !knownTokens.has(url)) {
      throw new Error(`图片数据已丢失,无法保存: ${url}`);
    }
  }
  if (pending.length === 0) return { markdown, updates };

  const dir = await dirname(targetFilePath);

  const references: PendingImageReference[] = [];
  let assetsDirReady = false;
  const ensureAssetsDir = async (): Promise<string> => {
    const assetsDir = await join(dir, 'assets');
    if (!assetsDirReady) {
      await invoke('create_directory', { path: assetsDir });
      assetsDirReady = true;
    }
    return assetsDir;
  };

  for (const image of pending) {
    const imageReferences = [image.placeholder, image.source?.url]
      .filter((url): url is string => !!url && urls.has(url));
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
        continue;
      }
    }

    // 新粘贴的图,或另存为到别处、原相对引用已经失效的图:复制进 assets。
    // 文件名去重,保证同名不同源的图各自留一份。
    const assetsDir = await ensureAssetsDir();
    const filename = await uniqueAssetName(assetsDir, image.filename);
    const targetPath = await join(assetsDir, filename);
    await invoke('save_binary_file', { path: targetPath, data: image.data });
    for (const reference of imageReferences) {
      references.push({ placeholder: reference, relativePath: `./assets/${filename}` });
    }
    updates.push({
      image,
      filename,
      source: { url: `./assets/${filename}`, absolutePath: targetPath },
    });
  }

  return { markdown: rewriteImageReferences(markdown, references), updates };
}

/**
 * 两个路径是否指向同一个文件。Windows 下大小写不敏感、两种分隔符等价,
 * 与 App.tsx 判断「同一文件是否已在别的标签打开」用的是同一套口径。
 */
function isSamePath(a: string, b: string): boolean {
  const normalize = (path: string) => path
    .replace(/\//g, '\\')
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/, '')
    .toLocaleLowerCase();
  return normalize(a) === normalize(b);
}

/**
 * 在 assets 里挑一个还没被占用的文件名。同名不同源的图片因此不会互相覆盖:
 * pic.png 已存在时,第二张写成 pic-1.png。
 */
async function uniqueAssetName(assetsDir: string, filename: string): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = attempt === 0 ? filename : `${stem}-${attempt}${ext}`;
    try {
      await fileMtime(await join(assetsDir, candidate));
    } catch {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * 将磁盘上已存在文档的相对图片引用转成短 token,显示数据仅存缓存。
 * 登记为 pending 后,保存时再转回相对路径并落盘。
 * 读不到的文件保留原引用(显示为加载失败),不阻断文档打开。
 */
export async function loadImageReferences(
  tabId: string,
  markdown: string,
  docPath: string,
): Promise<string> {
  const pending = getPendingImages(tabId);
  const seen = new Set(pending.map((image) => image.relativePath));
  const references: PendingImageReference[] = [];

  for (const url of getImageUrls(markdown)) {
    if (isExternalUrl(url)) continue;
    const relativePath = url.replace(/^\.\//, '');
    // 同一引用只处理一次,避免重复读文件与重复登记。
    if (seen.has(url)) continue;
    seen.add(url);

    let bytes: number[];
    let dataUrl: string;
    let assetPath: string;
    try {
      const image = await readImageFile(docPath, relativePath);
      assetPath = image.path;
      bytes = image.data;
      dataUrl = bytesToDataUrl(new Uint8Array(bytes), image.mime);
    } catch {
      continue;
    }

    const placeholder = `mdplus-image:${imageId()}`;
    rememberPendingImage(tabId, {
      placeholder,
      preview: dataUrl,
      // 原样保留作者写的引用。只有另存为到别的目录、这个引用不再指向同一
      // 个文件时,migratePendingImages 才会把它复制进 assets 并改写路径。
      relativePath: url,
      filename: basename(relativePath),
      data: bytes,
      source: { url, absolutePath: assetPath },
    });
    references.push({ placeholder: url, relativePath: placeholder });
  }

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
