import { invoke } from '@tauri-apps/api/core';
import { join, dirname } from '@tauri-apps/api/path';
import { rewriteImageReferences, type PendingImageReference } from './imagePaths';
import { basename, fileMtime, readBinaryFile } from './fileOps';

interface PendingImage extends PendingImageReference {
  filename: string;
  data: number[];
  /**
   * 打开文档时就已经在磁盘上的图片,记录它的原始引用与解析出的绝对路径。
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

function imageFilename(extension: string): string {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `image-${id}.${extension}`;
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

const MIME_BY_EXTENSION: Record<string, string> = {
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

function mimeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? 'image/png';
}

/** 匹配 Markdown 图片引用中的目标 URL,只捕获相对路径(不含 http/data/file/绝对路径)。 */
const IMAGE_URL_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

function isExternalUrl(url: string): boolean {
  return /^(?:https?:|data:|file:|[a-zA-Z]:[\\/]|\/|\/\/)/.test(url);
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

/**
 * 将某个未保存标签中的图片写入目标文档 assets 目录，并重写 Markdown 引用。
 * 图片字节保存在前端内存中，因此不依赖临时目录和跨磁盘 rename。
 */
export async function migratePendingImages(
  tabId: string,
  targetFilePath: string,
  markdown: string,
): Promise<string> {
  const pending = getPendingImages(tabId);
  if (pending.length === 0) return markdown;

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
    if (!markdown.includes(image.placeholder)) continue;

    // 磁盘上原有的图片:只要它相对新的保存位置仍然指向同一个文件,就把
    // 原引用原样写回。这既保住了作者自己的目录结构(如 ./img/pic.png),
    // 也避免了两张不同目录的同名图在 assets 里互相覆盖。
    if (image.source) {
      const resolved = await join(dir, image.source.url.replace(/^\.\//, ''));
      if (isSamePath(resolved, image.source.absolutePath)) {
        references.push({ placeholder: image.placeholder, relativePath: image.source.url });
        continue;
      }
    }

    // 新粘贴的图,或另存为到别处、原相对引用已经失效的图:复制进 assets。
    // 文件名去重,保证同名不同源的图各自留一份。
    const assetsDir = await ensureAssetsDir();
    const filename = await uniqueAssetName(assetsDir, image.filename);
    const targetPath = await join(assetsDir, filename);
    await invoke('save_binary_file', { path: targetPath, data: image.data });
    references.push({
      placeholder: image.placeholder,
      relativePath: `./assets/${filename}`,
    });
  }

  return rewriteImageReferences(markdown, references);
}

/**
 * 两个路径是否指向同一个文件。Windows 下大小写不敏感、两种分隔符等价,
 * 与 App.tsx 判断「同一文件是否已在别的标签打开」用的是同一套口径。
 */
function isSamePath(a: string, b: string): boolean {
  const normalize = (path: string) => path.replace(/\//g, '\\').toLocaleLowerCase();
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
 * 将磁盘上已存在的文档里的相对图片引用(如 `./assets/xxx.png`)转成 data URL,
 * 以便在编辑器里直接显示,同时登记为 pending,保存时再转回相对路径并落盘。
 * 读不到的文件保留原引用(显示为加载失败),不阻断文档打开。
 */
export async function loadImageReferences(
  tabId: string,
  markdown: string,
  docPath: string,
): Promise<string> {
  const dir = await dirname(docPath);

  const pending = getPendingImages(tabId);
  const seen = new Set(pending.map((image) => image.relativePath));
  let result = markdown;

  for (const match of markdown.matchAll(IMAGE_URL_RE)) {
    const url = match[1];
    if (isExternalUrl(url)) continue;
    const relativePath = url.replace(/^\.\//, '');
    // 同一引用只处理一次,避免重复读文件与重复登记。
    if (seen.has(url)) continue;
    seen.add(url);

    let bytes: number[];
    let dataUrl: string;
    let assetPath: string;
    try {
      assetPath = await join(dir, relativePath);
      bytes = await readBinaryFile(assetPath);
      dataUrl = bytesToDataUrl(new Uint8Array(bytes), mimeFromPath(assetPath));
    } catch {
      continue;
    }

    rememberPendingImage(tabId, {
      placeholder: dataUrl,
      // 原样保留作者写的引用。只有另存为到别的目录、这个引用不再指向同一
      // 个文件时,migratePendingImages 才会把它复制进 assets 并改写路径。
      relativePath: url,
      filename: basename(relativePath),
      data: bytes,
      source: { url, absolutePath: assetPath },
    });
    result = result.split(url).join(dataUrl);
  }

  return result;
}

/** 粘贴图片:统一用 data URL 保证编辑器立即可见,保存/另存为时再迁移为相对路径文件。 */
export async function saveImage(blob: Blob, tabId?: string): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const data = new Uint8Array(buffer);
  const extension = imageExtension(blob);
  const filename = imageFilename(extension);

  // 无论文档是否已保存,都先用 data URL 显示;pending 由保存/另存为统一迁移。
  const placeholder = await blobToDataUrl(blob);
  if (tabId) {
    rememberPendingImage(tabId, {
      placeholder,
      relativePath: `./assets/${filename}`,
      filename,
      data: Array.from(data),
    });
  }
  return placeholder;
}
