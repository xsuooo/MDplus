import { useCallback, useEffect, useRef, useState } from 'react';
import { showMessage } from '../lib/dialog';
import { errorMessage } from '../lib/errors';
import { getRecentFiles, removeRecentFile } from '../lib/store';
import type { RecentFile } from '../lib/types';
import { waitForWindowReady } from '../services/windowPersistence';

/** The recent-files list shown on the welcome screen and in the toolbar menu. */
export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [recentFilesReady, setRecentFilesReady] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /* ---------- 最近打开初始化 ---------- */
  useEffect(() => {
    let disposed = false;
    void getRecentFiles()
      .then((files) => {
        if (!disposed) setRecentFiles(files);
      })
      .catch((error) => {
        console.warn('最近文件读取不可用', error);
        void waitForWindowReady().then(() => {
          if (!disposed)
            void showMessage(
              `无法读取最近列表：${errorMessage(error)}。文稿文件未受影响。`,
              'error',
            );
        });
      })
      .finally(() => {
        if (!disposed) setRecentFilesReady(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  /** Re-reads the stored list after something changed it. */
  const refreshRecentFiles = useCallback(async () => {
    const files = await getRecentFiles();
    if (alive.current) setRecentFiles(files);
  }, []);

  const handleRemoveRecent = useCallback(
    async (path: string) => {
      try {
        await removeRecentFile(path);
        if (alive.current) await refreshRecentFiles();
      } catch (error) {
        if (alive.current)
          await showMessage(
            `最近列表更新失败，记录未确认移除：${errorMessage(error)}。请重试。`,
            'error',
          );
      }
    },
    [refreshRecentFiles],
  );

  return { recentFiles, recentFilesReady, setRecentFiles, refreshRecentFiles, handleRemoveRecent };
}
