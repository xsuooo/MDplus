import { isTauri } from '@tauri-apps/api/core';
import {
  availableMonitors,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from '@tauri-apps/api/window';
import { getWindowState, setWindowState } from '../lib/store';
import {
  clampToVisibleDisplays,
  windowStateToPersist,
  type DisplayWorkArea,
} from '../lib/windowState';

let preparation: Promise<void> | null = null;
let showing: Promise<void> | null = null;
let resolveWindowReady!: () => void;
const windowReady = new Promise<void>((resolve) => {
  resolveWindowReady = resolve;
});

/** 读取显示器工作区;权限缺失或调用失败时返回空数组,调用方跳过位置校正。 */
async function readDisplayWorkAreas(): Promise<DisplayWorkArea[]> {
  try {
    const monitors = await availableMonitors();
    return monitors.map(({ workArea }) => ({
      x: workArea.position.x,
      y: workArea.position.y,
      width: workArea.size.width,
      height: workArea.size.height,
    }));
  } catch {
    return [];
  }
}

export async function persistWindowState() {
  if (!isTauri()) return;
  try {
    await prepareWindowState();
    const win = getCurrentWindow();
    // 最小化窗口上报 -32000 坐标和极小尺寸,写回会毁掉上一次有效状态。
    if (await win.isMinimized()) return;
    const size = await win.innerSize();
    const position = await win.outerPosition();
    const maximized = await win.isMaximized();
    // 读取期间被最小化(用户点了最小化)时同样放弃本次写入。
    const minimized = await win.isMinimized();
    const previous = maximized ? await getWindowState() : null;
    const next = windowStateToPersist(
      {
        minimized,
        maximized,
        width: previous?.width ?? size.width,
        height: previous?.height ?? size.height,
        x: previous?.x ?? position.x,
        y: previous?.y ?? position.y,
      },
      await readDisplayWorkAreas(),
    );
    if (!next) return;
    await setWindowState(next);
  } catch {
    // 忽略错误
  }
}

export async function restoreWindowState() {
  if (!isTauri()) return;
  const win = getCurrentWindow();
  // 页面重新加载时保留当前窗口,不要把旧的持久化尺寸再应用一次。
  if (await win.isVisible()) return;
  const state = await getWindowState();
  if (state) {
    // 保存的坐标可能来自已拔掉的显示器:拉回当前某块显示器的工作区内。
    const placement = clampToVisibleDisplays(state, await readDisplayWorkAreas());
    await win.setSize(new PhysicalSize(placement.width, placement.height)).catch(() => {});
    await win.setPosition(new PhysicalPosition(placement.x, placement.y)).catch(() => {});
    if (placement.maximized) await win.maximize().catch(() => {});
  }
  // 系统可能沿用上次的最小化状态创建窗口:
  // 不显式还原的话,改尺寸和位置都不会让窗口出现,用户看到的是"打不开"。
  if (await win.isMinimized()) await win.unminimize().catch(() => {});
}

/** StrictMode、文件错误和渲染错误共用一次隐藏窗口恢复。 */
export function prepareWindowState(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  preparation ??= restoreWindowState().catch((error) => console.warn('窗口恢复不可用', error));
  return preparation;
}

/** 正常启动在初始界面落位后调用;恢复失败时仍让默认窗口和错误提示可见。 */
export function showInitialWindow(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  showing ??= (async () => {
    try {
      await prepareWindowState();
      const win = getCurrentWindow();
      await win.show().catch((error) => console.warn('显示窗口失败', error));
      await win.setFocus().catch((error) => console.warn('聚焦窗口失败', error));
    } catch (error) {
      console.warn('窗口启动不可用', error);
    } finally {
      resolveWindowReady();
    }
  })();
  return showing;
}

/** 启动文件读取失败时先等待窗口显现,不让原生错误框阻塞隐藏的父窗口。 */
export function waitForWindowReady(): Promise<void> {
  return isTauri() ? windowReady : Promise.resolve();
}
