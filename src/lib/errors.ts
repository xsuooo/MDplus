import { displayPath } from './pathDisplay';

/** 将 Tauri 字符串拒绝和普通 Error 统一转换为可读文案。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return displayPath(error.message);
  if (typeof error === 'string') return displayPath(error);
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const details = error as {
      message: unknown;
      recoveryPath?: unknown;
      backupPath?: unknown;
      writeState?: unknown;
    };
    const lines = [displayPath(String(details.message))];
    if (details.writeState === 'committed' || details.writeState === 'unknown') {
      lines.push('磁盘保存结果需要核对；已保留编辑内容，请勿直接再次覆盖原文件。');
    }
    if (typeof details.recoveryPath === 'string' && details.recoveryPath)
      lines.push(`本地编辑副本：${displayPath(details.recoveryPath)}`);
    if (typeof details.backupPath === 'string' && details.backupPath)
      lines.push(`原磁盘版本：${displayPath(details.backupPath)}`);
    return lines.join('\n');
  }
  return String(error);
}
