import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

const MD_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown'] },
  { name: '所有文件', extensions: ['*'] },
];

/** 读取文件文本内容 */
export async function readFile(path: string): Promise<string> {
  return invoke<string>('read_file', { path });
}

/** 读取文件二进制内容(如图片),返回字节数组 */
export async function readBinaryFile(path: string): Promise<number[]> {
  return invoke<number[]>('read_binary_file', { path });
}

/** 写入文件文本内容 */
export async function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>('write_file', { path, content });
}

/** 获取文件修改时间(毫秒) */
export async function fileMtime(path: string): Promise<number> {
  return invoke<number>('file_mtime', { path });
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
