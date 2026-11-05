import { WINDOW_PERSIST_MS } from '../config/constants';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';

import { persistWindowState, restoreWindowState } from '../services/windowState';

export function useWindowLifecycle() {
  useEffect(() => {
    if (isTauri())
      void restoreWindowState().catch((error) => console.warn('窗口恢复不可用', error));
  }, []);
  /* ---------- 窗口状态持久化 ---------- */
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlistenResized: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;
    // 移动/缩放事件高频触发,节流合并为一次持久化,避免持续空写 store。
    let pending = false;
    const throttled = () => {
      if (pending || disposed) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        if (!disposed) void persistWindowState();
      }, WINDOW_PERSIST_MS);
    };
    void (async () => {
      try {
        const win = getCurrentWindow();
        unlistenResized = await win.onResized(throttled);
        if (disposed) {
          unlistenResized();
          unlistenResized = undefined;
          return;
        }
        unlistenMoved = await win.onMoved(throttled);
        if (disposed) {
          unlistenMoved();
          unlistenMoved = undefined;
        }
      } catch (err) {
        console.warn('窗口状态监听不可用', err);
      }
    })();
    return () => {
      disposed = true;
      unlistenResized?.();
      unlistenMoved?.();
    };
  }, []);

  return { persistWindowState };
}
