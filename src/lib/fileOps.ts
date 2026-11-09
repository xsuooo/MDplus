import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

const MD_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown'] },
  { name: '所有文件', extensions: ['*'] },
];

/** Shapes follow src-tauri/src/file_contract.json; document writes never fall back to HTML export. */
/** path is the native validated absolute target, including for missing files. */
export interface DocumentSnapshot {
  path: string;
  content: string;
  revision: string;
  mtime: number;
}
export interface RevisionState {
  path: string;
  revision: string | null;
  mtime: number | null;
}
export interface WriteReceipt {
  path: string;
  revision: string;
  mtime: number;
  backupPath: string | null;
}
export interface ImageReceipt {
  filename: string;
  relativePath: string;
  path: string;
  /** Native ownership of a newly created asset; null means an existing asset was reused. */
  allocationId: string | null;
}

export async function readDocument(path: string): Promise<DocumentSnapshot> {
  return invoke<DocumentSnapshot>('read_document', { path });
}

export async function documentRevision(path: string): Promise<RevisionState> {
  return invoke<RevisionState>('document_revision', { path });
}

export async function writeDocument(
  path: string,
  content: string,
  expectedRevision: string | null,
): Promise<WriteReceipt> {
  return invoke<WriteReceipt>('write_document', { path, content, expectedRevision });
}

/** 由后端验证目录边界及图片格式,不提供任意文件二进制读取。 */
export async function readImageFile(
  docPath: string,
  relativePath: string,
): Promise<{
  path: string;
  mime: string;
  dataBase64: string;
}> {
  return invoke('read_image_file', { docPath, relativePath });
}

/** Export HTML to a validated .html target; never used for document saves. */
export async function exportHtmlFile(path: string, content: string): Promise<void> {
  return invoke<void>('export_html', { path, content });
}

/** 弹出打开文件对话框,返回路径或 null */
export async function pickOpenFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: MD_FILTERS,
    title: '打开 Markdown 文件',
  });
  if (typeof selected === 'string') return selected;
  return null;
}

export async function pickImageFiles(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }],
    title: '插入本地图片',
  });
  return selected === null ? [] : typeof selected === 'string' ? [selected] : selected;
}

/** 弹出另存为对话框,返回路径或 null */
export async function pickSaveFile(defaultPath?: string): Promise<string | null> {
  const selected = await save({
    defaultPath,
    filters: MD_FILTERS,
    title: '另存为',
  });
  if (typeof selected === 'string') return selected;
  return null;
}

/** 从路径提取文件名 */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
