import { WINDOW_PERSIST_MS } from '../config/constants';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';
import { BODY_FONTS, CODE_FONTS, readBodyFont, readCodeFont } from '../lib/editorFont';

import { persistWindowState, prepareWindowState, showInitialWindow } from '../services/windowState';

export function useWindowLifecycle(preferencesReady: boolean) {
  const [windowReady, setWindowReady] = useState(() => !isTauri());
  useEffect(() => {
    void prepareWindowState();
  }, []);

  useEffect(() => {
    if (!isTauri() || !preferencesReady) return;
    let disposed = false;
    void (async () => {
      await prepareWindowState();
      const fonts = document.fonts;
      if (fonts) {
        try {
          const body = BODY_FONTS.find((font) => font.id === readBodyFont())!;
          const code = CODE_FONTS.find((font) => font.id === readCodeFont())!;
          await Promise.allSettled([
            ...(typeof fonts.load === 'function'
              ? [
                  ...[body.family, ...code.family.split(', ')].map((family) =>
                    fonts.load(`400 16px ${family}`, '中文 Mixed'),
                  ),
                  fonts.load(`${body.strongWeight} 16px ${body.family}`, '中文 Bold'),
                ]
              : []),
          ]);
        } catch (error) {
          console.warn('启动字体准备不可用', error);
        }
      }
      if (disposed) return;
      // 隐藏窗口可能暂停动画帧;同步完成最终布局后直接显示,不依赖后台绘制时机。
      document.documentElement.getBoundingClientRect();
      await showInitialWindow();
      if (!disposed) setWindowReady(true);
    })();
    return () => {
      disposed = true;
    };
  }, [preferencesReady]);

  /* ---------- 窗口状态持久化 ---------- */
  useEffect(() => {
    if (!isTauri() || !windowReady) return;
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
  }, [windowReady]);

  return { persistWindowState, windowReady };
}
