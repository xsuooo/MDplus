import { message, ask } from '@tauri-apps/plugin-dialog';

/**
 * 统一对话框封装。
 * Tauri 环境用 plugin-dialog(原生对话框,平台行为一致);
 * 非 Tauri 环境(浏览器预览)回退到 window.alert / window.confirm。
 */

/** 显示信息 / 错误对话框 */
export async function showMessage(content: string, kind: 'info' | 'error' = 'info'): Promise<void> {
  try {
    await message(content, { title: 'MDPlus', kind });
  } catch {
    window.alert(content);
  }
}

/** 显示确认对话框,返回是否确认 */
export async function confirmDialog(content: string): Promise<boolean> {
  try {
    return await ask(content, { title: 'MDPlus', kind: 'warning' });
  } catch {
    return window.confirm(content);
  }
}