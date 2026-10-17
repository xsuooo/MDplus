import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { availableMonitors, getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/prose/state';
import { Toolbar } from './components/Toolbar';
import { TabBar } from './components/TabBar';
import { OutlinePanel } from './components/OutlinePanel';
import { StatusBar } from './components/StatusBar';
import { EditorTab } from './components/EditorTab';
import { SearchBar } from './components/SearchBar';
import { NewFileModal } from './components/NewFileModal';
import { ShortcutModal } from './components/ShortcutModal';
import { CloseConfirmModal } from './components/CloseConfirmModal';
import { RecentMenu } from './components/RecentMenu';
import { SourceEditor } from './components/SourceEditor';
import { readFile, writeFile, fileMtime, pickOpenFile, pickSaveFile, basename } from './lib/fileOps';
import { clearPendingImages, commitImageMigration, migratePendingImages, saveImage, loadImageReferences } from './lib/imageOps';
import { exportHTML, exportPDF } from './lib/export';
import { IconBrand } from './components/icons';
import {
  getRecentFiles,
  pushRecentFile,
  removeRecentFile,
  getThemeMode,
  setThemeMode,
  getSourceModePref,
  setSourceModePref,
  getWindowState,
  setWindowState,
  getOutlineOpen,
  setOutlineOpen as saveOutlineOpen,
  getShortcutBindings,
  saveShortcutBindings,
} from './lib/store';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  shortcutFromEvent,
  type ShortcutAction,
  type ShortcutBindings,
} from './lib/shortcuts';
import { getTemplate } from './lib/templates';
import { setMarkdown, undo, redo } from './lib/editor';
import { computeStats } from './lib/stats';
import { showMessage, confirmDialog } from './lib/dialog';
import { refreshMermaidTheme } from './lib/mermaid';
import { errorMessage } from './lib/errors';
import { startupView } from './lib/startup';
import { bindEditorZoomControls, nextEditorZoom, readEditorZoom, writeEditorZoom } from './lib/editorZoom';
import { clampToVisibleDisplays, windowStateToPersist, type DisplayWorkArea } from './lib/windowState';
import { readOutlineWidth, writeOutlineWidth } from './lib/outlineWidth';
import type { RecentFile, Tab, ThemeMode, EditorUpdate } from './lib/types';
import './styles/global.css';

const AUTO_SAVE_DELAY = 1500; // 停输 1.5s 自动保存
const EXTERNAL_POLL_MS = 2000; // 每 2s 检测外部文件变化

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

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function pathKey(path: string): string {
  return path.replace(/\//g, '\\').toLocaleLowerCase();
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [themeMode, setThemeModeState] = useState<ThemeMode>('light');
  const [sourceMode, setSourceMode] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineWidth, setOutlineWidth] = useState(readOutlineWidth);
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [pendingCloseTab, setPendingCloseTab] = useState<Tab | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [fileDialogBusy, setFileDialogBusy] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [startupResolved, setStartupResolved] = useState(() => !isTauri());
  const [editorZoom, setEditorZoom] = useState(readEditorZoom);
  // 快捷键表先用默认值渲染,启动后由已保存的绑定覆盖,避免首帧闪断
  const [shortcuts, setShortcuts] = useState<ShortcutBindings>(DEFAULT_SHORTCUTS);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // 编辑器实例注册表,避免每次输入都重渲染
  const editorRegistry = useRef<Record<string, Editor | null>>({});
  // 各标签页最新 markdown / outline 镜像
  const tabMirror = useRef<Record<string, EditorUpdate>>({});
  // tabs 的同步引用,便于在异步回调中读取最新状态
  const tabsRef = useRef<Tab[]>([]);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saveQueues = useRef<Record<string, Promise<boolean>>>({});
  // 递增令牌让已排队但尚未开始的保存在标签关闭后失效。
  const saveGenerations = useRef<Record<string, number>>({});
  // 内容版本用于识别另存为/磁盘写入期间是否有新编辑。
  const contentGenerations = useRef<Record<string, number>>({});
  const blockedExternalMtime = useRef<Record<string, number>>({});
  const openingPaths = useRef(new Set<string>());
  const externalChecks = useRef(new Set<string>());
  const externalPrompts = useRef(new Set<string>());
  const startupInitStarted = useRef(false);
  // 输入节流:每个标签最近一次未落定的 React 渲染同步定时器
  const tabRenderTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // 绑定表读盘完成前不写盘,否则默认值会覆盖用户的已存设置
  const shortcutsLoaded = useRef(false);

  const editorAreaRef = useRef<HTMLElement | null>(null);
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId) ?? null, [tabs, activeId]);

  useEffect(() => {
    const area = editorAreaRef.current;
    if (!area) return;
    return bindEditorZoomControls(area, (action) => setEditorZoom((value) => nextEditorZoom(value, action)));
  }, []);

  useEffect(() => {
    writeEditorZoom(editorZoom);
  }, [editorZoom]);

  /* ---------- 主题与偏好初始化 ---------- */
  useEffect(() => {
    void getThemeMode().then(setThemeModeState);
    void getSourceModePref().then(setSourceMode);
    void getOutlineOpen().then((open) => setOutlineOpen(open));
  }, []);

  useEffect(() => {
    const apply = () => {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const resolved = themeMode === 'system' ? (media.matches ? 'dark' : 'light') : themeMode;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    void setThemeMode(themeMode);
    refreshMermaidTheme(); // 让已渲染的 mermaid 图表跟随主题重绘
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => apply();
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [themeMode]);

  /* ---------- 最近打开初始化 ---------- */
  useEffect(() => {
    void getRecentFiles().then(setRecentFiles);
  }, []);

  /* ---------- 快捷键绑定载入 / 持久化 ---------- */
  useEffect(() => {
    let alive = true;
    void getShortcutBindings().then((loaded) => {
      if (!alive) return;
      shortcutsLoaded.current = true;
      setShortcuts(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!shortcutsLoaded.current) return;
    void saveShortcutBindings(shortcuts);
  }, [shortcuts]);

  /* ---------- 标签页操作 ---------- */
  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    tabsRef.current = tabsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t));
    setTabs([...tabsRef.current]);
  }, []);

  const addTab = useCallback(
    (init: { title: string; path: string | null; isNew: boolean; content: string; mtime?: number }, id: string = makeId()) => {
      const tab: Tab = {
        id,
        title: init.title,
        path: init.path,
        isNew: init.isNew,
        dirty: false,
        externalMtime: init.mtime ?? 0,
        externalChanged: false,
        initialContent: init.content,
        savedContent: init.content,
        markdown: init.content,
        stats: computeStats(init.content),
      };
      contentGenerations.current[id] = 0;
      tabsRef.current = [...tabsRef.current, tab];
      setTabs([...tabsRef.current]);
      setActiveId(id);
      setSearchOpen(false);
      setSourceMode(false);
      return id;
    },
    [],
  );

  const removeTab = useCallback((id: string) => {
    // 同步更新 tabsRef,确保关闭窗口流程里 onCloseRequested 能读到最新状态,
    // 否则保存后再次 close() 会因读到旧 dirty 标签而再次拦截,陷入死循环
    tabsRef.current = tabsRef.current.filter((t) => t.id !== id);
    saveGenerations.current[id] = (saveGenerations.current[id] ?? 0) + 1;
    delete contentGenerations.current[id];
    setTabs([...tabsRef.current]);
    delete editorRegistry.current[id];
    delete tabMirror.current[id];
    delete blockedExternalMtime.current[id];
    externalPrompts.current.delete(id);
    clearPendingImages(id);
    const timer = saveTimers.current[id];
    if (timer) clearTimeout(timer);
    delete saveTimers.current[id];
    setActiveId((cur) => {
      if (cur !== id) return cur;
      const remaining = tabsRef.current.filter((t) => t.id !== id);
      return remaining.length ? remaining[remaining.length - 1].id : null;
    });
  }, []);

  const closeTabRequest = useCallback(
    (id: string) => {
      // 从 tabsRef 读取,保证输入节流期间未落定到 state 的 dirty 也能被正确拦截
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
      if (tab.dirty) {
        setPendingCloseTab(tab);
      } else {
        removeTab(id);
      }
    },
    [removeTab],
  );

  // 关闭窗口流程:拦截 close 事件后,逐个确认未保存标签,全部处理完再真正关闭
  const pendingWindowClose = useRef(false);
  const pendingCloseQueue = useRef<string[]>([]);

  const persistWindowState = useCallback(async () => {
    if (!isTauri()) return;
    try {
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
  }, []);

  /* ---------- 保存 ---------- */
  /**
   * 获取标签页当前内容的权威镜像。
   * tabMirror 由编辑器 listener(渲染模式)与 handleSourceChange(源码模式)实时同步,
   * 始终为最新内容;避免从编辑器实例读取时拿到源码模式下未同步的陈旧内容,
   * 也避免 setTimeout 闭包捕获旧渲染的 sourceText 而丢最后一次输入。
   */
  const resolveContent = useCallback((tab: Tab): string => {
    return tabMirror.current[tab.id]?.markdown ?? tab.markdown;
  }, []);

  /**
   * 将图片迁移后的内容同步回编辑器实例、内容镜像与源码视图。
   * 仅在确认「写入期间没有新编辑」后调用;迁移未改变内容时直接返回。
   * 源码模式下同步 setSourceText,避免另存为后 textarea 仍显示旧的 data URL 占位,
   * 否则下一次源码编辑会用过期文本覆写镜像、把迁移结果静默回退。
   */
  const applyMigratedContent = useCallback(
    (tabId: string, migratedContent: string, originalContent: string): void => {
      if (migratedContent === originalContent) return;
      const editor = editorRegistry.current[tabId];
      if (editor) setMarkdown(editor, migratedContent);
      if (sourceMode && activeId === tabId) setSourceText(migratedContent);
      tabMirror.current[tabId] = {
        ...(tabMirror.current[tabId] ?? {
          markdown: migratedContent,
          outline: [],
          stats: computeStats(migratedContent),
          canUndo: false,
          canRedo: false,
        }),
        markdown: migratedContent,
        stats: computeStats(migratedContent),
      };
    },
    [activeId, sourceMode],
  );

  const handleSaveAsFor = useCallback(
    async (tab: Tab, generation: number, saveCurrent: () => Promise<boolean>): Promise<boolean> => {
      const isCurrentSave = () =>
        (saveGenerations.current[tab.id] ?? 0) === generation && tabsRef.current.some((candidate) => candidate.id === tab.id);
      try {
        if (!isCurrentSave()) return false;
        const target = await pickSaveFile(tab.path ?? `${tab.title}`);
        if (!target || !isCurrentSave()) return false;
        const latestBeforeWrite = tabsRef.current.find((candidate) => candidate.id === tab.id)!;
        // Choosing the current path must keep the normal external-change checks.
        if (latestBeforeWrite.path && pathKey(latestBeforeWrite.path) === pathKey(target)) {
          return saveCurrent();
        }
        const collision = tabsRef.current.find(
          (candidate) =>
            candidate.id !== tab.id &&
            candidate.path &&
            pathKey(candidate.path) === pathKey(target),
        );
        if (collision) {
          await showMessage(`「${collision.title}」已经打开,不能将两个标签保存到同一文件。`, 'error');
          return false;
        }

        const content = resolveContent(latestBeforeWrite);
        const contentGeneration = contentGenerations.current[tab.id] ?? 0;
        const migration = await migratePendingImages(tab.id, target, content);
        const migratedContent = migration.markdown;
        if (!isCurrentSave()) return false;
        await writeFile(target, migratedContent);
        if (!isCurrentSave()) return false;
        let mtime = 0;
        try {
          mtime = await fileMtime(target);
        } catch (error) {
          console.warn('文件已保存,但读取修改时间失败', error);
        }
        if (!isCurrentSave()) return false;
        const contentChangedDuringWrite =
          (contentGenerations.current[tab.id] ?? 0) !== contentGeneration;
        if (!contentChangedDuringWrite) {
          commitImageMigration(migration);
          applyMigratedContent(tab.id, migratedContent, content);
        }
        const latestContent = resolveContent(latestBeforeWrite);
        updateTab(tab.id, {
          path: target,
          title: basename(target),
          isNew: false,
          externalMtime: mtime,
          externalChanged: false,
          markdown: contentChangedDuringWrite ? latestContent : migratedContent,
          savedContent: migratedContent,
          dirty: contentChangedDuringWrite ? latestContent !== migratedContent : false,
        });
        delete blockedExternalMtime.current[tab.id];
        await pushRecentFile(target, basename(target));
        setRecentFiles(await getRecentFiles());
        return true;
      } catch (err) {
        if (!isCurrentSave()) return false;
        console.error('另存为失败', err);
        await showMessage(`另存为失败:${errorMessage(err)}`, 'error');
        return false;
      }
    },
    [resolveContent, updateTab, applyMigratedContent],
  );

  const performSave = useCallback(
    async (id: string, manual = false, generation = saveGenerations.current[id] ?? 0, saveAs = false): Promise<boolean> => {
      const isCurrentSave = () =>
        (saveGenerations.current[id] ?? 0) === generation && tabsRef.current.some((tab) => tab.id === id);

      if (!isCurrentSave()) return false;
      const tab = tabsRef.current.find((candidate) => candidate.id === id);
      if (!tab) return false;
      if (saveAs || !tab.path) {
        return manual
          ? handleSaveAsFor(tab, generation, () => performSave(id, true, generation))
          : false;
      }

      try {
        let diskMtime = 0;
        try {
          diskMtime = await fileMtime(tab.path);
        } catch (error) {
          if (!manual) {
            if (blockedExternalMtime.current[id] !== -1) {
              blockedExternalMtime.current[id] = -1;
              await showMessage(
                `无法读取「${tab.title}」的磁盘状态,自动保存已暂停。请按 Ctrl+S 手动处理。`,
                'error',
              );
            }
            return false;
          }
          const proceed = await confirmDialog(
            `无法读取「${tab.title}」的磁盘状态。\n\n继续可能会重新创建或覆盖该文件,是否仍然保存?`,
          );
          if (!proceed) return false;
          console.warn('保存前读取修改时间失败,用户选择继续', error);
        }

        const blockedMtime = blockedExternalMtime.current[id];
        const hasBlockedExternalChange = blockedMtime !== undefined && blockedMtime >= 0 && diskMtime === blockedMtime;
        const changedExternally =
          tab.externalMtime !== 0 &&
          diskMtime !== 0 &&
          diskMtime !== tab.externalMtime;
        const hasExternalConflict = changedExternally || hasBlockedExternalChange;
        if (hasExternalConflict) {
          if (!manual) {
            if (blockedExternalMtime.current[id] !== diskMtime) {
              blockedExternalMtime.current[id] = diskMtime;
              await showMessage(
                `「${tab.title}」已在磁盘上被修改,自动保存已暂停。请按 Ctrl+S 决定是否覆盖磁盘版本。`,
                'error',
              );
            }
            return false;
          }
          const overwrite = await confirmDialog(
            `「${tab.title}」已在磁盘上被修改。\n\n选择「确定」用当前编辑内容覆盖磁盘版本;选择「取消」保留未保存内容。`,
          );
          if (!overwrite) return false;
        }

        if (!isCurrentSave()) return false;
        // 确认框期间文件可能再次变化,写入前重新核对一次 mtime。
        if (diskMtime !== 0) {
          let latestDiskMtime: number;
          try {
            latestDiskMtime = await fileMtime(tab.path);
          } catch (error) {
            blockedExternalMtime.current[id] = -1;
            await showMessage(`无法确认「${tab.title}」的最新磁盘状态,本次保存已取消。请重试。`, 'error');
            console.warn('写入前读取修改时间失败', error);
            return false;
          }
          if (latestDiskMtime !== diskMtime) {
            blockedExternalMtime.current[id] = latestDiskMtime;
            await showMessage(`「${tab.title}」在确认期间再次被修改,本次保存已取消。请按 Ctrl+S 重新确认。`, 'error');
            return false;
          }
          diskMtime = latestDiskMtime;
        }
        const rawContent = resolveContent(tab);
        const contentGeneration = contentGenerations.current[id] ?? 0;
        const migration = await migratePendingImages(id, tab.path, rawContent);
        const content = migration.markdown;
        if (!isCurrentSave()) return false;
        await writeFile(tab.path, content);
        if (!isCurrentSave()) return false;
        let savedMtime = diskMtime;
        try {
          savedMtime = await fileMtime(tab.path);
        } catch (error) {
          console.warn('文件已保存,但读取修改时间失败', error);
        }
        if (!isCurrentSave()) return false;
        const contentChangedDuringWrite =
          (contentGenerations.current[id] ?? 0) !== contentGeneration;
        if (!contentChangedDuringWrite) {
          commitImageMigration(migration);
          applyMigratedContent(id, content, rawContent);
        }
        const latest = contentChangedDuringWrite
          ? (tabMirror.current[id]?.markdown ?? rawContent)
          : content;
        updateTab(id, {
          dirty: latest !== content,
          markdown: latest,
          externalMtime: savedMtime,
          externalChanged: false,
          savedContent: content,
        });
        delete blockedExternalMtime.current[id];
        return true;
      } catch (err) {
        if (!isCurrentSave()) return false;
        console.error('保存失败', err);
        await showMessage(`保存失败:${errorMessage(err)}`, 'error');
        return false;
      }
    },
    [handleSaveAsFor, resolveContent, updateTab, applyMigratedContent],
  );

  const doSave = useCallback(
    (id: string, manual = false, saveAs = false): Promise<boolean> => {
      const timer = saveTimers.current[id];
      if (timer) clearTimeout(timer);
      delete saveTimers.current[id];
      const previous = saveQueues.current[id] ?? Promise.resolve(true);
      const generation = saveGenerations.current[id] ?? 0;
      setSavingId(id);
      const next = previous.catch(() => false).then(() => performSave(id, manual, generation, saveAs));
      saveQueues.current[id] = next;
      void next.finally(() => {
        if (saveQueues.current[id] === next) {
          delete saveQueues.current[id];
          setSavingId((current) => (current === id ? null : current));
        }
      });
      return next;
    },
    [performSave],
  );

  const confirmClose = useCallback(
    async (action: 'save' | 'discard' | 'cancel') => {
      if (!pendingCloseTab) return;
      if (action === 'cancel') {
        setPendingCloseTab(null);
        pendingWindowClose.current = false;
        pendingCloseQueue.current = [];
        return;
      }
      if (action === 'save') {
        const tab = pendingCloseTab;
        const saved = await doSave(tab.id, true);
        if (!saved || tabsRef.current.find((candidate) => candidate.id === tab.id)?.dirty) return;
      }
      const closedId = pendingCloseTab.id;
      setPendingCloseTab(null);
      removeTab(closedId);
      // 关闭窗口流程:继续处理下一个未保存标签,全部完成后真正关闭窗口
      if (pendingWindowClose.current) {
        pendingCloseQueue.current = pendingCloseQueue.current.filter((id) => id !== closedId);
        const nextId = pendingCloseQueue.current[0];
        if (nextId) {
          const next = tabsRef.current.find((t) => t.id === nextId);
          if (next) setPendingCloseTab(next);
          else pendingWindowClose.current = false;
        } else {
          pendingWindowClose.current = false;
          try {
            await persistWindowState();
            await getCurrentWindow().destroy();
          } catch (err) {
            console.error('关闭窗口失败', err);
            await showMessage(`关闭窗口失败:${errorMessage(err)}`, 'error');
          }
        }
      }
    },
    [pendingCloseTab, removeTab, doSave, persistWindowState],
  );

  /* ---------- 打开 / 新建 ---------- */
  const openFileFromPath = useCallback(
    async (path: string) => {
      const key = pathKey(path);
      const alreadyOpen = tabsRef.current.find((t) => t.path && pathKey(t.path) === key);
      if (alreadyOpen) {
        setActiveId(alreadyOpen.id);
        return;
      }
      if (openingPaths.current.has(key)) return;
      openingPaths.current.add(key);
      try {
        const content = await readFile(path);
        const mtime = await fileMtime(path);
        const existing = tabsRef.current.find((t) => t.path && pathKey(t.path) === key);
        if (existing) {
          setActiveId(existing.id);
        } else {
          // 先确定标签 id,把文档里的相对图片引用转成短 token,通过预览缓存显示,
          // 并登记为 pending,保存时再转回相对路径落盘。
          const id = makeId();
          const displayContent = await loadImageReferences(id, content, path);
          addTab({ title: basename(path), path, isNew: false, content: displayContent, mtime }, id);
        }
        // 最近文件持久化不应阻塞文档标签创建或启动窗口显示。
        void pushRecentFile(path, basename(path)).then(async () => {
          setRecentFiles(await getRecentFiles());
        });
      } catch (err) {
        console.error('打开文件失败', err);
        await removeRecentFile(path);
        setRecentFiles(await getRecentFiles());
        await showMessage(`无法打开文件:${errorMessage(err)}\n\n如果该文件来自最近列表,已将失效记录移除。`, 'error');
      } finally {
        openingPaths.current.delete(key);
      }
    },
    [addTab],
  );

  const handleOpen = useCallback(async () => {
    if (fileDialogBusy) return; // 防止重复打开
    setFileDialogBusy(true);
    try {
      const path = await pickOpenFile();
      if (path) await openFileFromPath(path);
    } catch (err) {
      console.error('文件选择器打开失败', err);
      await showMessage(`无法打开文件选择器:${errorMessage(err)}`, 'error');
    } finally {
      setFileDialogBusy(false);
    }
  }, [openFileFromPath, fileDialogBusy]);

  /* ---------- 启动时打开命令行传递的文件 ---------- */
  useEffect(() => {
    if (!isTauri() || startupInitStarted.current) return;
    startupInitStarted.current = true;

    // 恢复窗口状态
    void getWindowState().then(async (state) => {
      const win = getCurrentWindow();
      if (state) {
        // 保存的坐标可能来自已拔掉的显示器:拉回当前某块显示器的工作区内。
        const placement = clampToVisibleDisplays(state, await readDisplayWorkAreas());
        void win.setSize(new LogicalSize(placement.width, placement.height)).catch(() => {});
        void win.setPosition(new LogicalPosition(placement.x, placement.y)).catch(() => {});
        if (placement.maximized) void win.maximize().catch(() => {});
      }
      // 系统可能沿用上次的最小化状态创建窗口,而 Rust 侧只负责 show:
      // 不显式还原的话,改尺寸和位置都不会让窗口出现,用户看到的是"打不开"。
      if (await win.isMinimized()) await win.unminimize().catch(() => {});
    });

    void invoke<string[]>('take_startup_files')
      .then((startupFiles) => {
        if (!Array.isArray(startupFiles) || startupFiles.length === 0) {
          setStartupResolved(true);
          return;
        }

        // 确保窗口可见
        const win = getCurrentWindow();
        void win.show();
        void win.setFocus();

        // 打开所有通过命令行传递的文件
        const openPromises = startupFiles.map(filePath => openFileFromPath(filePath));
        void Promise.all(openPromises).then(() => setStartupResolved(true));
      })
      .catch((err) => {
        console.error('读取启动文件失败', err);
        // 命令调用失败时仍结束启动占位,避免应用保持空白。
        setStartupResolved(true);
      });
  }, [openFileFromPath]);

  /* ---------- 监听单实例传递的文件 ---------- */
  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;
    let drainQueue = Promise.resolve();
    const drainPendingFiles = async () => {
      const openFiles = await invoke<string[]>('take_pending_open_files');
      if (Array.isArray(openFiles) && openFiles.length > 0) {
        // 窗口置顶并获得焦点
        const win = getCurrentWindow();
        void win.show();
        void win.setFocus();
        void win.unminimize();

        // 打开新传递的文件
        for (const filePath of openFiles) {
          void openFileFromPath(filePath);
        }
      }
    };
    const enqueueDrain = () => {
      drainQueue = drainQueue
        .then(drainPendingFiles)
        .catch((err) => console.error('读取单实例文件队列失败', err));
    };

    void listen('open-files', enqueueDrain)
      .then((dispose) => {
        unlisten = dispose;
        // 监听注册前到达的事件会留在后端队列,注册完成后主动补取一次。
        enqueueDrain();
      })
      .catch((err) => {
        console.error('注册单实例文件监听失败', err);
      });

    return () => unlisten?.();
  }, [openFileFromPath]);

  const handleRemoveRecent = useCallback(async (path: string) => {
    await removeRecentFile(path);
    setRecentFiles(await getRecentFiles());
  }, []);

  const handleNew = useCallback(
    (kind: 'blank' | 'basic') => {
      const content = getTemplate(kind);
      const count = tabsRef.current.filter((t) => t.isNew).length;
      const title = count === 0 ? '未命名文档.md' : `未命名文档 ${count + 1}.md`;
      addTab({ title, path: null, isNew: true, content, mtime: 0 });
      setNewModalOpen(false);
    },
    [addTab],
  );

  const handleSave = useCallback(async () => {
    if (activeId) await doSave(activeId, true);
  }, [activeId, doSave]);

  const handleSaveAs = useCallback(async () => {
    if (!activeTab) return;
    await doSave(activeTab.id, true, true);
  }, [activeTab, doSave]);

  const syncActiveEditorForExport = useCallback(
    async (tab: Tab) => {
      if (!sourceMode) return;
      const editor = editorRegistry.current[tab.id];
      if (!editor) return;
      const markdown = resolveContent(tab);
      setMarkdown(editor, markdown);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    },
    [resolveContent, sourceMode],
  );

  /* ---------- 导出功能 ---------- */
  const handleExportHTML = useCallback(async () => {
    if (!activeTab) return;
    try {
      await syncActiveEditorForExport(activeTab);
      const title = activeTab.title || '未命名';
      await exportHTML(title);
      await showMessage('HTML 导出成功', 'info');
    } catch (err) {
      console.error('导出 HTML 失败', err);
      await showMessage(`导出 HTML 失败: ${errorMessage(err)}`, 'error');
    }
  }, [activeTab, syncActiveEditorForExport]);

  const handleExportPDF = useCallback(async () => {
    if (!activeTab) return;
    try {
      await syncActiveEditorForExport(activeTab);
      await exportPDF();
    } catch (err) {
      console.error('导出 PDF 失败', err);
      await showMessage(`导出 PDF 失败: ${errorMessage(err)}`, 'error');
    }
  }, [activeTab, syncActiveEditorForExport]);

  /* ---------- 编辑器更新回传 ---------- */
  const scheduleAutoSave = useCallback(
    (id: string) => {
      const timer = saveTimers.current[id];
      if (timer) clearTimeout(timer);
      saveTimers.current[id] = setTimeout(() => void doSave(id), AUTO_SAVE_DELAY);
    },
    [doSave],
  );

  // 输入节流:tabsRef 始终即时更新(保存/关闭等正确性路径读取它),
  // 仅节流 React setTabs(视觉渲染),避免每次敲键都重渲染整个 App。
  const scheduleTabRender = useCallback((id: string) => {
    const existing = tabRenderTimers.current[id];
    if (existing) clearTimeout(existing);
    tabRenderTimers.current[id] = setTimeout(() => {
      delete tabRenderTimers.current[id];
      setTabs([...tabsRef.current]);
    }, 120);
  }, []);

  const handleTabUpdate = useCallback(
    (id: string, update: EditorUpdate, isInitial = false) => {
      tabMirror.current[id] = update;
      if (isInitial) {
        contentGenerations.current[id] ??= 0;
      } else {
        contentGenerations.current[id] = (contentGenerations.current[id] ?? 0) + 1;
      }
      const prev = tabsRef.current.find((t) => t.id === id);
      // 以「最近一次保存成功的内容」为基线判定 dirty,避免编辑又回到打开时内容后误判为已保存
      const dirty = isInitial ? false : prev ? update.markdown !== prev.savedContent : true;
      tabsRef.current = tabsRef.current.map((t) =>
        t.id === id ? { ...t, markdown: update.markdown, stats: update.stats, dirty } : t,
      );
      if (isInitial) {
        setTabs([...tabsRef.current]);
        return;
      }
      if (dirty) scheduleAutoSave(id);
      scheduleTabRender(id);
    },
    [scheduleAutoSave, scheduleTabRender],
  );

  const registerEditor = useCallback((id: string, editor: Editor | null) => {
    editorRegistry.current[id] = editor;
  }, []);

  /* ---------- 图片粘贴处理 ---------- */
  const handleImagePaste = useCallback(async (tabId: string, file: File): Promise<string> => {
    try {
      const imagePath = await saveImage(file, tabId);
      return imagePath;
    } catch (err) {
      console.error('保存图片失败', err);
      await showMessage(`保存图片失败: ${errorMessage(err)}`, 'error');
      throw err;
    }
  }, []);

  /* ---------- 撤销 / 重做 ---------- */
  const handleUndo = useCallback(() => {
    const editor = activeId ? editorRegistry.current[activeId] : null;
    if (editor) undo(editor);
  }, [activeId]);

  const handleRedo = useCallback(() => {
    const editor = activeId ? editorRegistry.current[activeId] : null;
    if (editor) redo(editor);
  }, [activeId]);

  /* ---------- 源码模式 ---------- */
  const sourceModeRef = useRef(false);

  const toggleSourceMode = useCallback(() => {
    setSourceMode((prev) => {
      const next = !prev;
      if (next) setSearchOpen(false);
      void setSourceModePref(next);
      return next;
    });
  }, []);

  // 退出源码模式:把所有标签的编辑器与各自最新镜像(tabMirror)对齐,
  // 避免非 active 标签的编辑器停留在进入源码模式前的旧内容
  useEffect(() => {
    if (sourceMode === sourceModeRef.current) return;
    sourceModeRef.current = sourceMode;
    if (!sourceMode) {
      for (const tab of tabsRef.current) {
        const editor = editorRegistry.current[tab.id];
        const latest = tabMirror.current[tab.id]?.markdown;
        if (editor && latest !== undefined) setMarkdown(editor, latest);
      }
    }
  }, [sourceMode]);

  // 源码模式下切换标签页时,载入对应文档内容
  useEffect(() => {
    if (!sourceMode) return;
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (tab) setSourceText(tabMirror.current[tab.id]?.markdown ?? tab.markdown);
  }, [activeId, sourceMode]);

  const handleSourceChange = useCallback(
    (text: string) => {
      setSourceText(text);
      if (activeId) {
        contentGenerations.current[activeId] = (contentGenerations.current[activeId] ?? 0) + 1;
        const prev = tabsRef.current.find((t) => t.id === activeId);
        const dirty = prev ? text !== prev.savedContent : true;
        const stats = computeStats(text);
        tabMirror.current[activeId] = {
          ...(tabMirror.current[activeId] ?? {
            markdown: text,
            outline: [],
            stats: { chars: 0, words: 0, lines: 1 },
            canUndo: false,
            canRedo: false,
          }),
          markdown: text,
          stats,
        };
        tabsRef.current = tabsRef.current.map((t) =>
          t.id === activeId ? { ...t, markdown: text, stats, dirty } : t,
        );
        if (dirty) scheduleAutoSave(activeId);
        scheduleTabRender(activeId);
      }
    },
    [activeId, scheduleAutoSave, scheduleTabRender],
  );

  /* ---------- 大纲面板状态持久化 ---------- */
  useEffect(() => {
    void saveOutlineOpen(outlineOpen);
  }, [outlineOpen]);

  useEffect(() => {
    writeOutlineWidth(outlineWidth);
  }, [outlineWidth]);

  useEffect(() => {
    if (!outlineOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOutlineOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [outlineOpen]);

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
      }, 500);
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
  }, [persistWindowState]);

  /* ---------- 大纲跳转 ---------- */
  const jumpToOutline = useCallback(
    (pos: number) => {
      const editor = activeId ? editorRegistry.current[activeId] : null;
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const target = pos + 1;
        if (target < 0 || target > view.state.doc.content.size) return;
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.near(view.state.doc.resolve(target)))
            .scrollIntoView(),
        );
        view.focus();
        // 兜底:确保滚动到目标标题元素
        requestAnimationFrame(() => {
          const dom = view.nodeDOM(pos);
          if (dom instanceof HTMLElement) {
            dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        });
      });
    },
    [activeId],
  );

  /* ---------- 外部文件变化检测 ---------- */
  const promptExternalReload = useCallback(
    async (tabId: string, detectedMtime: number) => {
      if (externalPrompts.current.has(tabId)) return;
      externalPrompts.current.add(tabId);
      try {
        const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
        if (!tab?.path || tab.dirty) return;

        const reload = await confirmDialog(
          `「${tab.title}」已在磁盘上被修改。\n\n选择「确定」重新加载文件;选择「取消」保留本地内容。`,
        );
        if (reload) {
          const content = await readFile(tab.path);
          const loadedMtime = await fileMtime(tab.path);
          const previous = tabMirror.current[tab.id];
          const nextStats = computeStats(content);
          tabMirror.current[tab.id] = {
            markdown: content,
            outline: previous?.outline ?? [],
            stats: nextStats,
            canUndo: previous?.canUndo ?? false,
            canRedo: previous?.canRedo ?? false,
          };
          const editor = editorRegistry.current[tab.id];
          if (editor) setMarkdown(editor, content);
          if (sourceMode && activeId === tab.id) setSourceText(content);
          delete blockedExternalMtime.current[tab.id];
          updateTab(tab.id, {
            markdown: content,
            stats: nextStats,
            dirty: false,
            externalMtime: loadedMtime,
            externalChanged: false,
            savedContent: content,
          });
        } else {
          // 保留本地内容时记录冲突 mtime,避免后续自动保存静默覆盖外部版本。
          blockedExternalMtime.current[tab.id] = detectedMtime;
          updateTab(tab.id, {
            externalMtime: detectedMtime,
            externalChanged: tab.id === activeId ? false : true,
          });
        }
      } catch (error) {
        const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
        if (blockedExternalMtime.current[tabId] !== -1) {
          blockedExternalMtime.current[tabId] = -1;
          if (tab?.id === activeId) {
            await showMessage(
              `无法读取「${tab.title}」的磁盘状态,文件可能已被删除或权限已变化。请按 Ctrl+S 手动处理。`,
              'error',
            );
          } else {
            updateTab(tabId, { externalChanged: true });
          }
        }
        console.warn('检测外部文件变化失败', error);
      } finally {
        externalPrompts.current.delete(tabId);
      }
    },
    [activeId, sourceMode, updateTab],
  );

  // 切回后台已变化的标签时再询问,避免后台标签弹窗打断当前编辑。
  useEffect(() => {
    if (!activeTab?.externalChanged || activeTab.dirty) return;
    void promptExternalReload(activeTab.id, activeTab.externalMtime);
  }, [activeTab?.dirty, activeTab?.externalChanged, activeTab?.externalMtime, activeTab?.id, promptExternalReload]);

  useEffect(() => {
    const timer = setInterval(() => {
      const candidates = tabsRef.current.filter(
        (tab) => tab.path && !tab.dirty && !externalChecks.current.has(tab.id),
      );
      for (const candidate of candidates) {
        externalChecks.current.add(candidate.id);
        void (async () => {
          try {
            const mtime = await fileMtime(candidate.path!);
            const latest = tabsRef.current.find((tab) => tab.id === candidate.id);
            if (!latest || latest.path !== candidate.path || latest.dirty) return;
            if (latest.externalMtime === 0) {
              updateTab(latest.id, { externalMtime: mtime });
              return;
            }
            if (mtime === 0 || mtime === latest.externalMtime) return;
            if (latest.id === activeId) {
              await promptExternalReload(latest.id, mtime);
            } else {
              updateTab(latest.id, { externalMtime: mtime, externalChanged: true });
            }
          } catch (error) {
            const latest = tabsRef.current.find((tab) => tab.id === candidate.id);
            if (
              latest &&
              latest.path === candidate.path &&
              blockedExternalMtime.current[latest.id] !== -1
            ) {
              blockedExternalMtime.current[latest.id] = -1;
              if (latest.id === activeId) {
                await showMessage(
                  `无法读取「${latest.title}」的磁盘状态,文件可能已被删除或权限已变化。请按 Ctrl+S 手动处理。`,
                  'error',
                );
              } else {
                updateTab(latest.id, { externalChanged: true });
              }
            }
            console.warn('检测外部文件变化失败', error);
          } finally {
            externalChecks.current.delete(candidate.id);
          }
        })();
      }
    }, EXTERNAL_POLL_MS);
    return () => clearInterval(timer);
  }, [activeId, promptExternalReload, updateTab]);

  /* ---------- 全局快捷键(唯一分发点) ---------- */
  const cycleTab = useCallback(
    (delta: number) => {
      const currentIndex = tabs.findIndex((t) => t.id === activeId);
      if (currentIndex === -1) return;
      const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
      setActiveId(tabs[nextIndex]?.id ?? null);
    },
    [activeId, tabs],
  );

  const runShortcut = useCallback(
    (action: ShortcutAction) => {
      switch (action) {
        case 'new':
          setNewModalOpen(true);
          return;
        case 'open':
          void handleOpen();
          return;
        case 'save':
          void handleSave();
          return;
        case 'saveAs':
          void handleSaveAs();
          return;
        case 'search':
          setSearchOpen((v) => !v);
          return;
        case 'toggleOutline':
          setOutlineOpen((v) => !v);
          return;
        case 'toggleSource':
          toggleSourceMode();
          return;
        case 'exportHtml':
          void handleExportHTML();
          return;
        case 'exportPdf':
          void handleExportPDF();
          return;
        case 'closeTab':
          if (activeId) void closeTabRequest(activeId);
          return;
        case 'nextTab':
          cycleTab(1);
          return;
        case 'prevTab':
          cycleTab(-1);
          return;
      }
    },
    [
      activeId,
      closeTabRequest,
      cycleTab,
      handleExportHTML,
      handleExportPDF,
      handleOpen,
      handleSave,
      handleSaveAs,
      toggleSourceMode,
    ],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 目标元素已处理过该按键(编辑器 keymap、工具栏菜单)时不再重复响应
      if (e.defaultPrevented) return;
      // 输入法组字中(e.key === 'Process' 覆盖部分中文输入法)不响应
      if (e.isComposing || e.key === 'Process') return;
      // 有模态框/确认对话框打开时不响应
      if (newModalOpen || shortcutsOpen || pendingCloseTab) return;

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && (key === 'z' || key === 'y')) {
        // 撤销/重做不走快捷键表:编辑器(contenteditable)聚焦时交给 Milkdown 自身 history keymap,避免重复撤销;
        // textarea/input(源码模式、搜索框、mermaid 编辑框)交给浏览器原生撤销
        const target = e.target as HTMLElement | null;
        const inEditable =
          !!target && (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
        if (inEditable) return;
        e.preventDefault();
        if (key === 'y' || e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }

      const accelerator = shortcutFromEvent(e);
      if (!accelerator) return;
      const definition = SHORTCUT_DEFINITIONS.find((item) => shortcuts[item.id] === accelerator);
      if (!definition) return;
      e.preventDefault();
      runShortcut(definition.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    shortcuts,
    newModalOpen,
    shortcutsOpen,
    pendingCloseTab,
    handleUndo,
    handleRedo,
    runShortcut,
  ]);

  /* ---------- 拖拽打开 ---------- */
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === 'over') {
            document.body.classList.add('dragging');
          } else if (event.payload.type === 'drop') {
            document.body.classList.remove('dragging');
            const md = event.payload.paths.filter((p) => /\.(md|markdown)$/i.test(p));
            md.forEach((p) => void openFileFromPath(p));
          } else if (event.payload.type === 'leave') {
            document.body.classList.remove('dragging');
          }
        });
      } catch (err) {
        console.warn('拖拽监听不可用', err);
      }
    })();
    return () => unlisten?.();
  }, [openFileFromPath]);

  /* ---------- 关闭窗口时确认未保存改动 ---------- */
  const beginWindowClose = useCallback(async () => {
    if (pendingWindowClose.current) return;
    const dirty = tabsRef.current.filter((tab) => tab.dirty);
    if (dirty.length === 0) {
      try {
        await persistWindowState();
        await getCurrentWindow().destroy();
      } catch (err) {
        console.error('关闭窗口失败', err);
        await showMessage(`关闭窗口失败:${errorMessage(err)}`, 'error');
      }
      return;
    }

    pendingWindowClose.current = true;
    pendingCloseQueue.current = dirty.map((tab) => tab.id);
    setPendingCloseTab(dirty[0]);
  }, [persistWindowState]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWindow()
        .onCloseRequested((event) => {
          event.preventDefault();
          void beginWindowClose();
        })
        .then((dispose) => {
          unlisten = dispose;
        })
        .catch((err) => {
          console.error('注册窗口关闭监听失败', err);
        });
    } catch {
      // 浏览器预览没有 Tauri 窗口事件,不影响编辑器使用。
    }
    return () => unlisten?.();
  }, [beginWindowClose]);

  const handleWindowClose = useCallback(() => {
    void beginWindowClose();
  }, [beginWindowClose]);

  /* ---------- 渲染 ---------- */
  const openRecents = useMemo(
    () => recentFiles.filter((f) => !tabs.some((t) => t.path && pathKey(t.path) === pathKey(f.path))),
    [recentFiles, tabs],
  );

  const activeSaveState =
    !activeTab
      ? 'idle'
      : savingId === activeTab.id
        ? 'saving'
        : activeTab.isNew
          ? 'unsaved'
          : activeTab.dirty
            ? 'dirty'
            : 'saved';
  const view = startupView(startupResolved, tabs.length);

  return (
    <div className="app">
      <Toolbar
        onOpen={() => void handleOpen()}
        onNew={() => setNewModalOpen(true)}
        onSave={() => void handleSave()}
        onSaveAs={() => void handleSaveAs()}
        onExportHTML={() => void handleExportHTML()}
        onExportPDF={() => void handleExportPDF()}
        hasActiveTab={Boolean(activeTab)}
        activeIsNew={Boolean(activeTab?.isNew)}
        saving={savingId === activeTab?.id}
        onSearch={() => setSearchOpen((v) => !v)}
        searchOpen={searchOpen}
        onToggleOutline={() => setOutlineOpen((v) => !v)}
        outlineOpen={outlineOpen}
        sourceMode={sourceMode}
        onToggleSource={toggleSourceMode}
        onRecent={() => setRecentMenuOpen((v) => !v)}
        recentOpen={recentMenuOpen}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onWindowClose={handleWindowClose}
      />

      <TabBar
        tabs={tabs}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={closeTabRequest}
        onNew={() => setNewModalOpen(true)}
      />

      <div className="app-body">
        {outlineOpen && (
          <button
            className="outline-backdrop"
            onClick={() => setOutlineOpen(false)}
            aria-label="关闭目录"
            tabIndex={-1}
          />
        )}
        <OutlinePanel
          open={outlineOpen}
          onToggle={() => setOutlineOpen((v) => !v)}
          width={outlineWidth}
          onWidthChange={setOutlineWidth}
          items={activeTab ? (tabMirror.current[activeId ?? '']?.outline ?? []) : []}
          onJump={jumpToOutline}
        />

        <main
          className="editor-area"
          ref={editorAreaRef}
          style={{ '--editor-zoom': editorZoom / 100 } as CSSProperties}
        >
          {view === 'loading' ? (
            <div className="startup-placeholder" aria-hidden="true" />
          ) : view === 'welcome' ? (
            <div className="welcome">
              <div className="welcome-logo" aria-hidden="true">
                <IconBrand size={72} />
              </div>
              <p className="welcome-kicker">Markdown 工作台</p>
              <h1>开始一个文档</h1>
              <p className="welcome-sub">新建空白文档,或继续编辑最近打开的文件。</p>
              <div className="welcome-actions">
                <button className="btn btn-primary" onClick={() => setNewModalOpen(true)}>
                  新建文档
                </button>
                <button className="btn" onClick={() => void handleOpen()}>
                  打开文件
                </button>
              </div>
              {openRecents.length > 0 && (
                <div className="welcome-recents">
                  <div className="welcome-recents-title">最近打开</div>
                  {openRecents.slice(0, 5).map((f) => (
                    <button key={f.path} className="welcome-recent-item" onClick={() => void openFileFromPath(f.path)}>
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
              <p className="welcome-drop-hint">也可以把 Markdown 文件拖进窗口打开</p>
            </div>
          ) : (
            tabs.map((tab) => (
              <EditorTab
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                onUpdate={handleTabUpdate}
                onRegister={registerEditor}
                onImagePaste={handleImagePaste}
              />
            ))
          )}

          {activeTab && searchOpen && (
            <SearchBar
              key={activeId}
              editor={activeId ? editorRegistry.current[activeId] ?? null : null}
              onClose={() => setSearchOpen(false)}
            />
          )}

          {activeTab && sourceMode && (
            <SourceEditor
              key={activeTab.id}
              tabId={activeTab.id}
              value={sourceText}
              onChange={handleSourceChange}
              onClose={toggleSourceMode}
              onImagePaste={handleImagePaste}
            />
          )}
        </main>
      </div>

      <StatusBar
        tab={activeTab}
        themeMode={themeMode}
        onThemeMode={setThemeModeState}
        sourceMode={sourceMode}
        saveState={activeSaveState}
        zoom={editorZoom}
        onResetZoom={() => setEditorZoom(100)}
      />

      {newModalOpen && <NewFileModal onCancel={() => setNewModalOpen(false)} onConfirm={handleNew} />}

      {shortcutsOpen && (
        <ShortcutModal
          bindings={shortcuts}
          onChange={setShortcuts}
          onClose={() => setShortcutsOpen(false)}
        />
      )}

      {pendingCloseTab && (
        <CloseConfirmModal
          title={pendingCloseTab.title}
          onConfirm={(action) => void confirmClose(action)}
        />
      )}

      {recentMenuOpen && (
        <RecentMenu
          items={recentFiles}
          onOpen={(path) => {
            setRecentMenuOpen(false);
            void openFileFromPath(path);
          }}
          onRemove={(path) => void handleRemoveRecent(path)}
          onClose={() => setRecentMenuOpen(false)}
        />
      )}
    </div>
  );
}
