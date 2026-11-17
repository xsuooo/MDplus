/** Image bytes: encoding, hashing and the native stash that holds them outside JS memory. */
import { invoke } from '@tauri-apps/api/core';
import { LIMITS } from '../../config/constants';
import { readImageFile } from '../fileOps';
import { type FileBacking, type ImageBacking } from './cache';
import { isSamePath } from './references';

export const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};
export function imageId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
export function imageByteLength(dataBase64: string): number {
  if (typeof dataBase64 !== 'string' || dataBase64.length % 4 !== 0)
    throw new Error('图片编码无效');
  const length =
    (dataBase64.length / 4) * 3 -
    (dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0);
  if (length <= 0 || length > LIMITS.imageFileBytes) throw new Error('图片为空或超过 64 MiB 限制');
  return length;
}
export function decodeImage(dataBase64: string): Uint8Array<ArrayBuffer> {
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
export function encodeImage(bytes: Uint8Array): string {
  const chunks: string[] = [];
  // Multiple of three: only the last independently encoded block has padding.
  for (let offset = 0; offset < bytes.length; offset += 0x6000)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 0x6000))));
  return chunks.join('');
}
export async function digestImage(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function isStashFull(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'STASH_FULL'
  );
}
export async function stashImage(
  filename: string,
  dataBase64: string,
  existing?: ImageBacking,
  /** Given only where the bytes may stay in the document's own file when the stash is full. */
  file?: { docPath: string; relativePath: string; mime: string },
): Promise<ImageBacking> {
  const byteLength = imageByteLength(dataBase64);
  // At most one transfer/hash operation runs globally. No persistent image bytes
  // remain in JS: two raw-size working buffers fit the configured 128 MiB budget,
  // while the compact base64 IPC string is itself bounded by the 64 MiB limit.
  if (byteLength * 2 > LIMITS.imageMemoryBytes) throw new Error('图片传输内存预算不足');
  const digest = await digestImage(decodeImage(dataBase64));
  // A file-backed image never takes this shortcut: every preparation retries its admission.
  if (existing && existing.key !== null && existing.digest === digest && existing.owners > 0) {
    existing.owners += 1;
    return existing;
  }
  let stashed: { key: string; mime: string; previewUrl: string };
  try {
    stashed = await invoke<{ key: string; mime: string; previewUrl: string }>('stash_image', {
      filename,
      dataBase64,
    });
  } catch (error) {
    // Only exhausted capacity is survivable. Every other failure keeps rejecting.
    if (!file || !isStashFull(error)) throw error;
    if (
      existing?.key === null &&
      existing.owners > 0 &&
      existing.digest === digest &&
      isSamePath(existing.file.docPath, file.docPath) &&
      existing.file.relativePath === file.relativePath
    ) {
      existing.owners += 1;
      return existing;
    }
    return {
      key: null,
      previewUrl: null,
      file: { docPath: file.docPath, relativePath: file.relativePath },
      mime: file.mime,
      byteLength,
      digest,
      owners: 1,
    };
  }
  return {
    key: stashed.key,
    mime: stashed.mime,
    previewUrl: stashed.previewUrl,
    byteLength,
    digest,
    owners: 1,
  };
}
/** A file-backed image is only as good as its hash: never hand out other bytes. */
export async function readFileBacking(backing: FileBacking): Promise<string> {
  const stale = new Error(`图片文件在准备后已变化或无法读取，请重试: ${backing.file.relativePath}`);
  let dataBase64: string;
  try {
    ({ dataBase64 } = await readImageFile(backing.file.docPath, backing.file.relativePath));
  } catch {
    throw stale;
  }
  if (
    imageByteLength(dataBase64) !== backing.byteLength ||
    (await digestImage(decodeImage(dataBase64))) !== backing.digest
  )
    throw stale;
  return dataBase64;
}
