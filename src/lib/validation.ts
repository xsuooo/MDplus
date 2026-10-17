import type { RecentFile, ThemeMode } from './types';
import type { ShortcutBindings } from './shortcuts';
import { sanitizeShortcuts } from './shortcuts';

/** 过滤持久化数据,避免损坏的设置让界面在启动时崩溃。 */
export function sanitizeRecentFiles(value: unknown, max = 10): RecentFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<RecentFile> => typeof item === 'object' && item !== null)
    .filter((item) => typeof item.path === 'string' && item.path.length > 0 && typeof item.name === 'string')
    .map((item) => ({
      path: item.path as string,
      name: item.name as string,
      time: typeof item.time === 'number' ? item.time : 0,
    }))
    .slice(0, max);
}

export function sanitizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'light';
}

export function sanitizeSourceMode(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

/** 快捷键绑定：损坏或缺失的条目回落到默认绑定，null 表示显式未绑定。 */
export function sanitizeShortcutBindings(value: unknown): ShortcutBindings {
  return sanitizeShortcuts(value);
}
