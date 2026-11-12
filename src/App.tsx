import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloseConfirmModal } from './components/CloseConfirmModal';
import { EditorTab } from './components/EditorTab';
import { IconBrand } from './components/icons';
import { MediaViewer } from './components/MediaViewer';
import { NewFileModal } from './components/NewFileModal';
import { OutlinePanel } from './components/OutlinePanel';
import { RecentMenu } from './components/RecentMenu';
import { RecoveryModal } from './components/RecoveryModal';
import { SearchBar } from './components/SearchBar';
import { SettingsNotice } from './components/SettingsNotice';
import { SessionRestoreNotice } from './components/SessionRestoreNotice';
import { ImageDropNotice } from './components/ImageDropNotice';
import { ShortcutModal } from './components/ShortcutModal';
import { SourceEditor } from './components/SourceEditor';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { Toolbar } from './components/Toolbar';
import { useDocumentClose } from './hooks/useDocumentClose';
import { useDocumentExport } from './hooks/useDocumentExport';
import { useDocumentFiles } from './hooks/useDocumentFiles';
import { useDocumentSave } from './hooks/useDocumentSave';
import { useDocumentSession } from './hooks/useDocumentSession';
import { useEditorView } from './hooks/useEditorView';
import { useExternalChanges } from './hooks/useExternalChanges';
import { useImageDrop } from './hooks/useImageDrop';
import { usePreferences } from './hooks/usePreferences';
import { useRecovery } from './hooks/useRecovery';
import { useWindowLifecycle } from './hooks/useWindowLifecycle';
import type { MediaPreview } from './lib/media';
import type { ImageDropResult } from './lib/imageDrop';
import type { SourceEditorApi } from './lib/sourceEditorApi';
import { showMessage } from './lib/dialog';
import { errorMessage } from './lib/errors';
import { readOutlineWidth, writeOutlineWidth } from './lib/outlineWidth';
import { pathKey } from './lib/pathIdentity';
import { displayPath } from './lib/pathDisplay';
import { resolveDocumentLink } from './lib/documentLinks';
import { Presence } from './lib/presence';
import {
  createShortcutIndex,
  dispatchShortcut,
  isComposingEvent,
  type ShortcutAction,
} from './lib/shortcuts';
import { startupView } from './lib/startup';
import { cycleTabIndex, type TabWheelDirection } from './lib/tabWheel';
import './styles/global.css';
import './styles/workflow.css';

export default function App() {
  const session = useDocumentSession();
  const sourceApis = useRef<Record<string, SourceEditorApi>>({});
  const imageDropHandler = useRef<
    | ((paths: readonly string[], position: { x: number; y: number }) => Promise<ImageDropResult>)
    | null
  >(null);
  const [imageDropResult, setImageDropResult] = useState<ImageDropResult | null>(null);
  const registerSourceApi = useCallback((id: string, api: SourceEditorApi | null) => {
    if (api) sourceApis.current[id] = api;
    else delete sourceApis.current[id];
  }, []);
  const getSourceApi = useCallback((id: string) => sourceApis.current[id] ?? null, []);
  const routeImageDrop = useCallback(
    async (paths: string[], position: { x: number; y: number }) => {
      const handle = imageDropHandler.current;
      if (!handle) return;
      setImageDropResult(null);
      try {
        setImageDropResult(await handle(paths, position));
      } catch (error) {
        setImageDropResult({
          attempted: paths.length,
          inserted: 0,
          failures: paths.map((path) => ({ path, message: errorMessage(error) })),
        });
      }
    },
    [],
  );
  const {
    themeMode,
    outlineOpen,
    shortcuts,
    settingsError,
    preferencesReady,
    retrySettings,
    changeThemeMode,
    changeOutlineOpen,
    changeShortcuts,
    changeSourcePreference,
  } = usePreferences(session.setSourceMode);
  const {
    tabs,
    activeId,
    sourceMode,
    searchOpen,
    setSearchOpen,
    activeTab,
    editorRegistry,
    blockedExternalMtime,
    sourceRegistry,
    sourceRewrites,
    selectTab,
    registerSource,
    resolveContent,
  } = session;
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
  useEffect(() => {
    setMediaPreview(null);
  }, [activeId, sourceMode]);
  const [outlineWidth, setOutlineWidth] = useState(readOutlineWidth);
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  // 快捷键表先用默认值渲染,启动后由已保存的绑定覆盖,避免首帧闪断
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const {
    recentFiles,
    recentFilesReady,
    setRecentFiles,
    startupResolved,
    openFileFromPath,
    handleOpen,
    handleRemoveRecent,
    createDocument,
    sessionRestoreEnabled,
    changeSessionRestore,
    sessionFailures,
    retrySessionFailures,
    sessionRestoreBusy,
    sessionController,
  } = useDocumentFiles(session, { onImageDrop: routeImageDrop });
  const handleDocumentLink = useCallback(
    async (tabId: string, href: string) => {
      const tab = session.tabsRef.current.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      try {
        const link = await resolveDocumentLink(href, tab.path);
        const opened = await openFileFromPath(link.path);
        if (opened && link.hasFragment)
          await showMessage('已打开文稿，未定位到标题；当前暂不支持链接中的标题锚点。');
      } catch (error) {
        await showMessage(errorMessage(error), 'error');
      }
    },
    [session.tabsRef, openFileFromPath],
  );
  const { persistWindowState, windowReady } = useWindowLifecycle(
    preferencesReady && recentFilesReady,
  );
  const recovery = useRecovery(session);
  useExternalChanges(session, recovery);
  const { doSave, scheduleAutoSave, handleSave, handleSaveAs, savingId } = useDocumentSave(
    session,
    recovery,
    setRecentFiles,
  );
  const {
    editorAreaRef,
    bodyFont,
    codeFont,
    editorWidth,
    changeBodyFont,
    changeCodeFont,
    changeEditorWidth,
    handleTabUpdate,
    handleEditorActivity,
    registerEditor,
    handleImagePaste,
    handleUndo,
    handleRedo,
    toggleSourceMode,
    handleSourceChange,
    jumpToOutline,
    outlineItems,
    outlineStatus,
  } = useEditorView(session, recovery, scheduleAutoSave, changeSourcePreference, outlineOpen);
  const {
    handle: dropImages,
    pick: pickImages,
    picking: pickingImage,
    progress: imageDropProgress,
  } = useImageDrop(session, getSourceApi);
  imageDropHandler.current = dropImages;
  const undoActiveView = useCallback(() => {
    const current = session.currentView.current;
    if (current.sourceMode && current.activeId) sourceApis.current[current.activeId]?.undo();
    else handleUndo();
  }, [session.currentView, handleUndo]);
  const redoActiveView = useCallback(() => {
    const current = session.currentView.current;
    if (current.sourceMode && current.activeId) sourceApis.current[current.activeId]?.redo();
    else handleRedo();
  }, [session.currentView, handleRedo]);
  const handleSessionRestoreChange = useCallback(
    (enabled: boolean) => {
      void changeSessionRestore(enabled).catch((error) => {
        void showMessage(`无法保存会话恢复设置：${errorMessage(error)}`, 'error');
      });
    },
    [changeSessionRestore],
  );
  const { exporting, handleExportHTML, handleExportPDF } = useDocumentExport(
    session,
    recovery,
    bodyFont,
    codeFont,
  );
  const onClosing = useCallback(() => setMediaPreview(null), []);
  const { pendingCloseTab, closeBusy, closeTabRequest, confirmClose, handleWindowClose } =
    useDocumentClose(session, recovery, doSave, persistWindowState, onClosing, sessionController);
  const {
    refreshRecovery,
    handleRestore,
    recoveryEntries,
    recoveryOpen,
    setRecoveryOpen,
    recoveryStates,
    handleRecoveryRemoved,
  } = recovery;

  /* ---------- 标签页操作 ---------- */
  useEffect(() => {
    writeOutlineWidth(outlineWidth);
  }, [outlineWidth]);

  useEffect(() => {
    if (!outlineOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 输入法组字时的 Esc 是取消候选词(Chrome 上 keyCode 为 229),不能顺手关面板
      if (isComposingEvent(event)) return;
      // 搜索框、mermaid 编辑框、对话框等已经消费了这次 Esc,不要再关大纲
      if (event.defaultPrevented) return;
      event.preventDefault();
      changeOutlineOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [outlineOpen, changeOutlineOpen]);

  /* ---------- 全局快捷键(唯一分发点) ---------- */
  const cycleTab = useCallback(
    (delta: TabWheelDirection | number) => {
      const currentIndex = tabs.findIndex((t) => t.id === activeId);
      const nextIndex = cycleTabIndex(currentIndex, tabs.length, delta);
      if (nextIndex === null) return;
      selectTab(tabs[nextIndex]?.id ?? null);
    },
    [activeId, tabs, selectTab],
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
          changeOutlineOpen((v) => !v);
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
      changeOutlineOpen,
      closeTabRequest,
      cycleTab,
      handleExportHTML,
      handleExportPDF,
      handleOpen,
      handleSave,
      handleSaveAs,
      setSearchOpen,
      toggleSourceMode,
    ],
  );

  // 键位索引:一个动作可以挂多个键位,规范化后建表;同一组合键按定义顺序取第一个,与冲突提示一致
  const shortcutIndex = useMemo(() => createShortcutIndex(shortcuts), [shortcuts]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 目标元素已处理过该按键(编辑器 keymap、工具栏菜单)时不再重复响应
      if (e.defaultPrevented) return;
      // 输入法组字中(e.key === 'Process' 覆盖部分中文输入法)不响应
      if (isComposingEvent(e) || e.getModifierState('AltGraph')) return;
      // 有模态框/确认对话框打开时不响应
      if (newModalOpen || shortcutsOpen || pendingCloseTab || recoveryOpen || mediaPreview) return;

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Alt 组合不参与:AltGr 布局下 Ctrl+Alt+Z 是正常输入,Ctrl+Alt+Z 交给下面的快捷键表处理
      if (mod && !e.altKey && (key === 'z' || key === 'y')) {
        // 撤销/重做不走快捷键表:编辑器(contenteditable)聚焦时交给 Milkdown 自身 history keymap,避免重复撤销;
        // 源码组件自行处理撤销;其它 textarea/input 交给浏览器。
        const target = e.target as HTMLElement | null;
        const inEditable =
          !!target &&
          (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
        if (inEditable) return;
        e.preventDefault();
        if (key === 'y' || e.shiftKey) redoActiveView();
        else undoActiveView();
        return;
      }

      dispatchShortcut(e, shortcutIndex, runShortcut);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    shortcutIndex,
    newModalOpen,
    shortcutsOpen,
    pendingCloseTab,
    recoveryOpen,
    mediaPreview,
    undoActiveView,
    redoActiveView,
    runShortcut,
  ]);

  /* ---------- 渲染 ---------- */
  const openRecents = useMemo(
    () =>
      recentFiles.filter((f) => !tabs.some((t) => t.path && pathKey(t.path) === pathKey(f.path))),
    [recentFiles, tabs],
  );

  const activeSaveState = !activeTab
    ? 'idle'
    : savingId === activeTab.id
      ? 'saving'
      : activeTab.id in blockedExternalMtime.current || activeTab.externalChanged
        ? 'paused'
        : activeTab.isNew
          ? 'unsaved'
          : activeTab.dirty
            ? 'dirty'
            : 'saved';
  const view = startupView(startupResolved && (tabs.length > 0 || recentFilesReady), tabs.length);

  return (
    <div className="app" data-body-font={bodyFont} data-starting={!windowReady}>
      <SettingsNotice error={settingsError} onRetry={retrySettings} />
      <SessionRestoreNotice
        failures={sessionFailures}
        busy={sessionRestoreBusy}
        onRetry={() => void retrySessionFailures()}
      />
      <Toolbar
        bindings={shortcuts}
        exporting={exporting}
        onOpen={() => void handleOpen()}
        onNew={() => setNewModalOpen(true)}
        onSave={() => void handleSave()}
        onSaveAs={() => void handleSaveAs()}
        onInsertImage={() => {
          setImageDropResult(null);
          void pickImages()
            .then((result) => {
              if (result) setImageDropResult(result);
            })
            .catch((error) => showMessage(`无法插入本地图片：${errorMessage(error)}`, 'error'));
        }}
        pickingImage={pickingImage || imageDropProgress !== null}
        onExportHTML={() => void handleExportHTML()}
        onExportPDF={() => void handleExportPDF()}
        hasActiveTab={Boolean(activeTab)}
        activeIsNew={Boolean(activeTab?.isNew)}
        saving={savingId === activeTab?.id}
        onSearch={() => setSearchOpen((v) => !v)}
        searchOpen={searchOpen}
        onToggleOutline={() => changeOutlineOpen((v) => !v)}
        outlineOpen={outlineOpen}
        sourceMode={sourceMode}
        onToggleSource={toggleSourceMode}
        onRecent={() => setRecentMenuOpen((v) => !v)}
        recentOpen={recentMenuOpen}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onWindowClose={handleWindowClose}
      />

      <TabBar
        bindings={shortcuts}
        tabs={tabs}
        activeId={activeId}
        onSelect={selectTab}
        onClose={closeTabRequest}
        onNew={() => setNewModalOpen(true)}
        onWheelSwitch={cycleTab}
      />

      <ImageDropNotice
        result={imageDropResult}
        progress={imageDropProgress}
        onDismiss={() => setImageDropResult(null)}
      />

      <div className="app-body">
        <Presence present={outlineOpen}>
          <button
            className="outline-backdrop"
            onClick={() => changeOutlineOpen(false)}
            aria-label="关闭目录"
            tabIndex={-1}
          />
        </Presence>
        <OutlinePanel
          open={outlineOpen}
          onToggle={() => changeOutlineOpen((v) => !v)}
          width={outlineWidth}
          onWidthChange={setOutlineWidth}
          items={activeTab ? outlineItems : []}
          status={outlineStatus}
          onJump={jumpToOutline}
        />

        <main
          className="editor-area"
          data-source-mode={sourceMode}
          data-editor-width={editorWidth}
          ref={editorAreaRef}
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
                    <button
                      key={f.path}
                      className="welcome-recent-item"
                      title={displayPath(f.path)}
                      aria-label={`${f.name}，${displayPath(f.path)}`}
                      onClick={() => void openFileFromPath(f.path)}
                    >
                      <span>{f.name}</span>
                      <span className="welcome-recent-path">
                        {displayPath(f.path).replace(/[^\\/]+$/, '')}
                      </span>
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
                tabId={tab.id}
                initialContent={tab.initialContent}
                active={tab.id === activeId}
                sourceMode={tab.id === activeId && sourceMode}
                onUpdate={handleTabUpdate}
                onActivity={handleEditorActivity}
                onRegister={registerEditor}
                onImagePaste={handleImagePaste}
                onMediaPreview={setMediaPreview}
                onDocumentLink={handleDocumentLink}
              />
            ))
          )}

          <Presence key={activeId} present={Boolean(activeTab) && searchOpen}>
            <SearchBar
              documentId={activeId ?? undefined}
              editor={!sourceMode && activeId ? (editorRegistry.current[activeId] ?? null) : null}
              source={
                sourceMode && activeTab
                  ? {
                      input: sourceRegistry.current[activeTab.id] ?? null,
                      text: resolveContent(activeTab),
                      api: getSourceApi(activeTab.id),
                    }
                  : undefined
              }
              onClose={() => setSearchOpen(false)}
            />
          </Presence>

          {tabs.map((tab) => (
            <SourceEditor
              key={tab.id}
              tabId={tab.id}
              active={tab.id === activeId && sourceMode}
              value={resolveContent(tab)}
              onRegister={registerSource}
              onApi={registerSourceApi}
              imageRewrites={sourceRewrites.current[tab.id]}
              onChange={handleSourceChange}
              onClose={toggleSourceMode}
              onImagePaste={handleImagePaste}
            />
          ))}
        </main>
      </div>

      <StatusBar
        bindings={shortcuts}
        tab={activeTab}
        themeMode={themeMode}
        onThemeMode={changeThemeMode}
        sourceMode={sourceMode}
        saveState={activeSaveState}
        editorAreaRef={editorAreaRef}
        bodyFont={bodyFont}
        codeFont={codeFont}
        onBodyFont={changeBodyFont}
        onCodeFont={changeCodeFont}
        editorWidth={editorWidth}
        onEditorWidth={changeEditorWidth}
        recoveryStatus={activeId ? recoveryStates[activeId] : undefined}
        onRecovery={() => {
          setRecoveryOpen(true);
          void refreshRecovery();
        }}
      />

      <Presence present={Boolean(mediaPreview)}>
        {mediaPreview && <MediaViewer media={mediaPreview} onClose={() => setMediaPreview(null)} />}
      </Presence>
      <Presence present={newModalOpen}>
        <NewFileModal
          onCancel={() => setNewModalOpen(false)}
          onConfirm={(kind) => {
            createDocument(kind);
            setNewModalOpen(false);
          }}
        />
      </Presence>
      <Presence present={recoveryOpen}>
        <RecoveryModal
          entries={recoveryEntries}
          onRestore={handleRestore}
          onRemove={handleRecoveryRemoved}
          onClose={() => setRecoveryOpen(false)}
        />
      </Presence>

      <Presence present={shortcutsOpen}>
        <ShortcutModal
          bindings={shortcuts}
          onChange={changeShortcuts}
          onClose={() => setShortcutsOpen(false)}
        />
      </Presence>

      <Presence present={Boolean(pendingCloseTab)}>
        {pendingCloseTab && (
          <CloseConfirmModal
            title={pendingCloseTab.title}
            busy={closeBusy}
            onConfirm={(action) => void confirmClose(action)}
          />
        )}
      </Presence>

      <Presence present={recentMenuOpen}>
        <RecentMenu
          items={recentFiles}
          onOpen={(path) => {
            setRecentMenuOpen(false);
            void openFileFromPath(path);
          }}
          onRemove={(path) => void handleRemoveRecent(path)}
          restoreSessionEnabled={sessionRestoreEnabled}
          onRestoreSessionChange={handleSessionRestoreChange}
          sessionRestoreBusy={sessionRestoreBusy}
          sessionFailureCount={sessionFailures.length}
          onRetrySession={() => void retrySessionFailures()}
          onClose={() => setRecentMenuOpen(false)}
        />
      </Presence>
    </div>
  );
}
