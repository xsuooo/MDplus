import { Store } from '@tauri-apps/plugin-store';
import type { RecentFile, ThemeMode } from './types';
import { sanitizeRecentFiles, sanitizeSourceMode, sanitizeThemeMode } from './validation';

const STORE_FILE = 'mdplus-settings.json';
const KEY_RECENT = 'recent-files';
const KEY_THEME = 'theme-mode';
const KEY_SOURCE_MODE = 'source-mode';
const KEY_WINDOW_STATE = 'window-state';
const KEY_OUTLINE_OPEN = 'outline-open';
const MAX_RECENT = 10;

interface WindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

let storePromise: Promise<Store> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load(STORE_FILE);
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
export async function pushRecentFile(path: string, name: string): Promise<void> {
  try {
    await enqueueStoreWrite(async (store) => {
      const list = await store.get<RecentFile[]>(KEY_RECENT);
      const next = [
        { path, name, time: Date.now() },
        ...sanitizeRecentFiles(list, MAX_RECENT).filter((f) => f.path !== path),
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
      await store.set(KEY_RECENT, sanitizeRecentFiles(list, MAX_RECENT).filter((f) => f.path !== path));
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
  try {
    await enqueueStoreWrite((store) => store.set(KEY_THEME, mode));
  } catch {
    // 忽略
  }
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
  try {
    await enqueueStoreWrite((store) => store.set(KEY_SOURCE_MODE, enabled));
  } catch {
    // 忽略
  }
}

/** 读取窗口状态 */
export async function getWindowState(): Promise<WindowState | null> {
  try {
    const store = await getStore();
    const v = await store.get<WindowState>(KEY_WINDOW_STATE);
    if (v && typeof v.width === 'number' && typeof v.height === 'number') {
      return { ...v, maximized: v.maximized === true };
    }
    return null;
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
  try {
    await enqueueStoreWrite((store) => store.set(KEY_OUTLINE_OPEN, open));
  } catch {
    // 忽略
  }
}
