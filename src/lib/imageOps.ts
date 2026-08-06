import { invoke } from '@tauri-apps/api/core';
import { join, dirname } from '@tauri-apps/api/path';

/** 保存图片到文档同级 assets 目录 */
export async function saveImage(blob: Blob, currentFilePath: string | null): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const data = new Uint8Array(buffer);

  // 生成文件名
  const timestamp = Date.now();
  const extension = blob.type.split('/')[1] || 'png';
  const filename = `image-${timestamp}.${extension}`;

  let targetPath: string;
  let relativePath: string;

  if (currentFilePath) {
    // 文档已保存，保存到同级 assets 目录
    const dir = await dirname(currentFilePath);
    const assetsDir = await join(dir, 'assets');
    targetPath = await join(assetsDir, filename);
    relativePath = `./assets/${filename}`;

    // 确保 assets 目录存在
    try {
      await invoke('create_directory', { path: assetsDir });
    } catch {
      // 目录可能已存在，忽略错误
    }
  } else {
    // 文档未保存，保存到临时目录
    const tempDir = await join(await invoke<string>('get_temp_dir'), 'mdplus-images');
    targetPath = await join(tempDir, filename);
    relativePath = targetPath;

    try {
      await invoke('create_directory', { path: tempDir });
    } catch {
      // 忽略
    }
  }

  await invoke('save_binary_file', { path: targetPath, data: Array.from(data) });
  return relativePath;
}
