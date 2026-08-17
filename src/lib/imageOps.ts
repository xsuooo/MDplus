import { invoke } from '@tauri-apps/api/core';
import { join, dirname } from '@tauri-apps/api/path';
import { rewriteImageReferences, type PendingImageReference } from './imagePaths';
import { readBinaryFile } from './fileOps';

export interface PendingImage extends PendingImageReference {
  filename: string;
  data: number[];
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

/** 从路径提取文件名。 */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
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

export function getPendingImages(tabId: string): PendingImage[] {
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
  const assetsDir = await join(dir, 'assets');
  await invoke('create_directory', { path: assetsDir });

  const references: PendingImageReference[] = [];
  for (const image of pending) {
    if (!markdown.includes(image.placeholder)) continue;
    const targetPath = await join(assetsDir, image.filename);
    await invoke('save_binary_file', { path: targetPath, data: image.data });
    references.push({
      placeholder: image.placeholder,
      relativePath: `./assets/${image.filename}`,
    });
  }

  return rewriteImageReferences(markdown, references);
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
    // 同一相对路径只处理一次,避免重复读文件与重复登记。
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);

    let bytes: number[];
    let dataUrl: string;
    try {
      const assetPath = await join(dir, relativePath);
      bytes = await readBinaryFile(assetPath);
      dataUrl = bytesToDataUrl(new Uint8Array(bytes), mimeFromPath(assetPath));
    } catch {
      continue;
    }

    rememberPendingImage(tabId, {
      placeholder: dataUrl,
      relativePath: `./assets/${basename(relativePath)}`,
      filename: basename(relativePath),
      data: bytes,
    });
    result = result.split(url).join(dataUrl);
  }

  return result;
}

/** 粘贴图片:统一用 data URL 保证编辑器立即可见,保存/另存为时再迁移为相对路径文件。 */
export async function saveImage(blob: Blob, _currentFilePath: string | null, tabId?: string): Promise<string> {
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
