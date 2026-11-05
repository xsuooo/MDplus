import { LIMITS } from '../config/constants';
import { loadSettingsStore, type SettingsStore as Store } from '../services/settingsStore';
import type { RecentFile, ThemeMode } from './types';
import type { ShortcutBindings } from './shortcuts';
import { sanitizeWindowState, type WindowState } from './windowState';
import { pathKey } from './pathIdentity';
import {
  sanitizeRecentFiles,
  sanitizeShortcutBindings,
  sanitizeSourceMode,
  sanitizeThemeMode,
} from './validation';

const KEY_RECENT = 'recent-files';
const KEY_THEME = 'theme-mode';
const KEY_SOURCE_MODE = 'source-mode';
const KEY_WINDOW_STATE = 'window-state';
const KEY_OUTLINE_OPEN = 'outline-open';
const KEY_SHORTCUTS = 'shortcuts';
const MAX_RECENT = LIMITS.recentFiles;

export type { WindowState };

let storePromise: Promise<Store> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function getStore(): Promise<Store> {
  if (!storePromise) {
    const loading = loadSettingsStore().catch((error) => {
      // Concurrent callers share this attempt; a transient failure permits retry.
      if (storePromise === loading) storePromise = null;
      throw error;
    });
    storePromise = loading;
  }
  return storePromise;
}

function enqueueStoreWrite(task: (store: Store) => Promise<void>): Promise<void> {
  const operation = writeQueue.then(async () => {
    const store = await getStore();
    await task(store);
    await store.save();
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export interface UserPreferences {
  themeMode: ThemeMode;
  sourceMode: boolean;
  outlineOpen: boolean;
  shortcuts: ShortcutBindings;
}

/** Startup recovery needs to distinguish a failed read from actual default values. */
export async function loadPreferences(): Promise<UserPreferences> {
  await writeQueue;
  const store = await getStore();
  const [theme, source, outline, shortcuts] = await Promise.all([
    store.get(KEY_THEME),
    store.get(KEY_SOURCE_MODE),
    store.get(KEY_OUTLINE_OPEN),
    store.get(KEY_SHORTCUTS),
  ]);
  return {
    themeMode: sanitizeThemeMode(theme),
    sourceMode: sanitizeSourceMode(source),
    outlineOpen: typeof outline === 'boolean' ? outline : false,
    shortcuts: sanitizeShortcutBindings(shortcuts),
  };
}

/** 最近打开的文件列表 */
export async function getRecentFiles(): Promise<RecentFile[]> {
  try {
    await writeQueue;
    const store = await getStore();
    const list = await store.get<RecentFile[]>(KEY_RECENT);
    return sanitizeRecentFiles(list, MAX_RECENT);
  } catch {
    return [];
  }
}

/** 把一次打开记录写入最近列表 */
export async function pushRecentFile(
  path: string,
  name: string,
  requestedPath = path,
): Promise<void> {
  try {
    await enqueueStoreWrite(async (store) => {
      const list = await store.get<RecentFile[]>(KEY_RECENT);
      const next = [
        { path, name, time: Date.now() },
        ...sanitizeRecentFiles(list, MAX_RECENT).filter(
          (f) => pathKey(f.path) !== pathKey(path) && pathKey(f.path) !== pathKey(requestedPath),
        ),
      ].slice(0, MAX_RECENT);
      await store.set(KEY_RECENT, next);
    });
  } catch {
    // 忽略持久化失败
  }
}

/** 移除一条最近记录 */
export async function removeRecentFile(path: string): Promise<void> {
  try {
    await enqueueStoreWrite(async (store) => {
      const list = await store.get<RecentFile[]>(KEY_RECENT);
      await store.set(
        KEY_RECENT,
        sanitizeRecentFiles(list, MAX_RECENT).filter((f) => pathKey(f.path) !== pathKey(path)),
      );
    });
  } catch {
    // 忽略
  }
}

/** 读取主题偏好(默认浅色) */
export async function getThemeMode(): Promise<ThemeMode> {
  try {
    const store = await getStore();
    const v = await store.get<ThemeMode>(KEY_THEME);
    return sanitizeThemeMode(v);
  } catch {
    return 'light';
  }
}

/** 写入主题偏好 */
export async function setThemeMode(mode: ThemeMode): Promise<void> {
  await enqueueStoreWrite((store) => store.set(KEY_THEME, mode));
}

/** 读取源码模式偏好 */
export async function getSourceModePref(): Promise<boolean> {
  try {
    const store = await getStore();
    const v = await store.get<boolean>(KEY_SOURCE_MODE);
    return sanitizeSourceMode(v);
  } catch {
    return false;
  }
}

/** 写入源码模式偏好 */
export async function setSourceModePref(enabled: boolean): Promise<void> {
  await enqueueStoreWrite((store) => store.set(KEY_SOURCE_MODE, enabled));
}

/** 读取窗口状态 */
export async function getWindowState(): Promise<WindowState | null> {
  try {
    const store = await getStore();
    // 最小化期间写下的哨兵坐标、过小尺寸等无效记录在这里被丢弃,回落到默认窗口。
    return sanitizeWindowState(await store.get(KEY_WINDOW_STATE));
  } catch {
    return null;
  }
}

/** 保存窗口状态 */
export async function setWindowState(state: WindowState): Promise<void> {
  try {
    await enqueueStoreWrite((store) => store.set(KEY_WINDOW_STATE, state));
  } catch {
    // 忽略
  }
}

/** 读取大纲面板状态 */
export async function getOutlineOpen(): Promise<boolean> {
  try {
    const store = await getStore();
    const v = await store.get<boolean>(KEY_OUTLINE_OPEN);
    return typeof v === 'boolean' ? v : false;
  } catch {
    return false;
  }
}

/** 保存大纲面板状态 */
export async function setOutlineOpen(open: boolean): Promise<void> {
  await enqueueStoreWrite((store) => store.set(KEY_OUTLINE_OPEN, open));
}

/** 读取快捷键绑定(损坏时回落到默认表) */
export async function getShortcutBindings(): Promise<ShortcutBindings> {
  try {
    await writeQueue;
    const store = await getStore();
    const v = await store.get<ShortcutBindings>(KEY_SHORTCUTS);
    return sanitizeShortcutBindings(v);
  } catch {
    return sanitizeShortcutBindings(null);
  }
}

/** 写入快捷键绑定 */
export async function saveShortcutBindings(bindings: ShortcutBindings): Promise<void> {
  await enqueueStoreWrite((store) => store.set(KEY_SHORTCUTS, bindings));
}
