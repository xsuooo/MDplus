import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useRef, useState } from 'react';
import { showMessage } from '../lib/dialog';
import { needsDocumentProtection } from '../lib/documentProtection';
import { errorMessage } from '../lib/errors';
import type { Tab } from '../lib/types';

import type { DocumentSession } from './useDocumentSession';
import type { RecoveryController } from './useRecovery';

export function useDocumentClose(
  session: DocumentSession,
  recovery: Pick<RecoveryController, 'cleanRecovery' | 'protectDraft'>,
  doSave: (id: string, manual?: boolean) => Promise<boolean>,
  persistWindowState: () => Promise<void>,
  onClosing: () => void,
) {
  const { tabsRef, contentGenerations, resolveContent, removeTab } = session;
  const { cleanRecovery, protectDraft } = recovery;
  const [pendingCloseTab, setPendingCloseState] = useState<Tab | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const pendingClose = useRef<Tab | null>(null);
  const setPendingCloseTab = useCallback((tab: Tab | null) => {
    pendingClose.current = tab;
    setPendingCloseState(tab);
  }, []);
  // One request generation covers every await in tab/window close. Cancelling
  // invalidates closing continuations independently of the disk save itself.
  const closeGeneration = useRef(0);
  const confirmingClose = useRef<number | null>(null);
  const pendingWindowClose = useRef(false);

  const closeTabRequest = useCallback(
    (id: string) => {
      // 从 tabsRef 读取,保证输入节流期间未落定到 state 的 dirty 也能被正确拦截
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || pendingWindowClose.current) return;
      const request = ++closeGeneration.current;
      confirmingClose.current = null;
      setCloseBusy(false);
      if (needsDocumentProtection(tab, resolveContent(tab))) {
        protectDraft(tab);
        setPendingCloseTab(tab);
      } else {
        const generation = contentGenerations.current[id];
        void cleanRecovery(id).then((clean) => {
          if (closeGeneration.current !== request) return;
          const current = tabsRef.current.find((item) => item.id === id);
          if (
            current &&
            (contentGenerations.current[id] !== generation ||
              needsDocumentProtection(current, resolveContent(current)))
          ) {
            protectDraft(current);
            setPendingCloseTab(current);
          } else if (clean) removeTab(id);
          else void showMessage('无法清理恢复副本，本次关闭已取消。请重试。', 'error');
        });
      }
    },
    [
      tabsRef,
      setPendingCloseTab,
      contentGenerations,
      cleanRecovery,
      removeTab,
      protectDraft,
      resolveContent,
    ],
  );

  // Initially clean windows and the final confirmed tab share the same barriers.
  // A fixed queue misses edits in tabs which were clean at the first request.
  const continueWindowClose = useCallback(
    async (request: number) => {
      const isCurrent = () => pendingWindowClose.current && closeGeneration.current === request;
      const offerDirtyTab = () => {
        const dirty = tabsRef.current.find((tab) =>
          needsDocumentProtection(tab, resolveContent(tab)),
        );
        if (!dirty) return false;
        protectDraft(dirty);
        setPendingCloseTab(dirty);
        return true;
      };
      if (!isCurrent() || offerDirtyTab()) return;
      try {
        const cleaned = await Promise.all(tabsRef.current.map((tab) => cleanRecovery(tab.id)));
        if (!isCurrent()) return;
        if (cleaned.some((success) => !success)) {
          pendingWindowClose.current = false;
          await showMessage('无法清理恢复副本，本次退出已取消。请重试。', 'error');
          return;
        }
        if (offerDirtyTab()) return;
        await persistWindowState();
        if (!isCurrent() || offerDirtyTab()) return;
        await getCurrentWindow().destroy();
        if (isCurrent()) pendingWindowClose.current = false;
      } catch (err) {
        if (!isCurrent()) return;
        pendingWindowClose.current = false;
        console.error('关闭窗口失败', err);
        await showMessage(`关闭窗口失败:${errorMessage(err)}`, 'error');
      }
    },
    [tabsRef, protectDraft, setPendingCloseTab, resolveContent, persistWindowState, cleanRecovery],
  );

  const confirmClose = useCallback(
    async (action: 'save' | 'discard' | 'cancel') => {
      const pendingCloseTab = pendingClose.current;
      if (!pendingCloseTab) return;
      if (action === 'cancel') {
        ++closeGeneration.current;
        confirmingClose.current = null;
        setCloseBusy(false);
        setPendingCloseTab(null);
        pendingWindowClose.current = false;
        return;
      }
      if (confirmingClose.current !== null) return;
      const request = closeGeneration.current;
      const isCurrent = () => closeGeneration.current === request;
      confirmingClose.current = request;
      setCloseBusy(true);
      const closedId = pendingCloseTab.id;
      try {
        if (action === 'save') {
          const saved = await doSave(closedId, true);
          const savedTab = tabsRef.current.find((candidate) => candidate.id === closedId);
          if (
            !isCurrent() ||
            !saved ||
            !savedTab ||
            needsDocumentProtection(savedTab, resolveContent(savedTab))
          )
            return;
        }
        const closingGeneration = contentGenerations.current[closedId];
        const clean = await cleanRecovery(closedId);
        const current = tabsRef.current.find((tab) => tab.id === closedId);
        if (!isCurrent()) {
          if (current && needsDocumentProtection(current, resolveContent(current)))
            protectDraft(current);
          return;
        }
        if (!clean) {
          await showMessage('无法清理恢复副本，本次关闭已取消。请重试。', 'error');
          return;
        }
        if (
          contentGenerations.current[closedId] !== closingGeneration ||
          (action === 'save' &&
            current &&
            needsDocumentProtection(current, resolveContent(current)))
        ) {
          if (current) {
            protectDraft(current);
            setPendingCloseTab(current);
          }
          return;
        }
        setPendingCloseTab(null);
        removeTab(closedId);
        if (pendingWindowClose.current) await continueWindowClose(request);
      } catch (error) {
        if (!isCurrent()) return;
        const current = tabsRef.current.find((tab) => tab.id === closedId);
        if (current) {
          protectDraft(current);
          setPendingCloseTab(current);
        }
        console.error('关闭文稿失败', error);
        await showMessage(`关闭失败，文稿仍保留，请重试：${errorMessage(error)}`, 'error');
      } finally {
        if (confirmingClose.current === request) {
          confirmingClose.current = null;
          setCloseBusy(false);
        }
      }
    },
    [
      setPendingCloseTab,
      contentGenerations,
      cleanRecovery,
      tabsRef,
      removeTab,
      continueWindowClose,
      doSave,
      protectDraft,
      resolveContent,
    ],
  );

  /* ---------- 关闭窗口时确认未保存改动 ---------- */
  const beginWindowClose = useCallback(async () => {
    onClosing();
    if (pendingWindowClose.current) return;
    const request = ++closeGeneration.current;
    confirmingClose.current = null;
    setCloseBusy(false);
    pendingWindowClose.current = true;
    await continueWindowClose(request);
  }, [continueWindowClose, onClosing]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      void getCurrentWindow()
        .onCloseRequested((event) => {
          event.preventDefault();
          void beginWindowClose();
        })
        .then((dispose) => {
          if (disposed) dispose();
          else unlisten = dispose;
        })
        .catch((err) => {
          console.error('注册窗口关闭监听失败', err);
        });
    } catch {
      // 浏览器预览没有 Tauri 窗口事件,不影响编辑器使用。
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [beginWindowClose]);

  const handleWindowClose = useCallback(() => {
    void beginWindowClose();
  }, [beginWindowClose]);

  return { pendingCloseTab, closeBusy, closeTabRequest, confirmClose, handleWindowClose };
}
