import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
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
import { usePreferences } from './hooks/usePreferences';
import { useRecovery } from './hooks/useRecovery';
import { useWindowLifecycle } from './hooks/useWindowLifecycle';
import type { MediaPreview } from './lib/media';
import { readOutlineWidth, writeOutlineWidth } from './lib/outlineWidth';
import { pathKey } from './lib/pathIdentity';
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

export default function App() {
  const session = useDocumentSession();
  const {
    themeMode,
    outlineOpen,
    shortcuts,
    settingsError,
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
    tabMirror,
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
  const { persistWindowState } = useWindowLifecycle();
  const {
    recentFiles,
    setRecentFiles,
    startupResolved,
    openFileFromPath,
    handleOpen,
    handleRemoveRecent,
    createDocument,
  } = useDocumentFiles(session);
  const recovery = useRecovery(session);
  useExternalChanges(session);
  const { doSave, scheduleAutoSave, handleSave, handleSaveAs, savingId } = useDocumentSave(
    session,
    recovery,
    setRecentFiles,
  );
  const {
    editorAreaRef,
    editorZoom,
    setEditorZoom,
    bodyFont,
    codeFont,
    changeBodyFont,
    changeCodeFont,
    handleTabUpdate,
    registerEditor,
    handleImagePaste,
    handleUndo,
    handleRedo,
    toggleSourceMode,
    handleSourceChange,
    jumpToOutline,
  } = useEditorView(session, recovery, scheduleAutoSave, changeSourcePreference);
  const { exporting, handleExportHTML, handleExportPDF } = useDocumentExport(
    session,
    recovery,
    bodyFont,
    codeFont,
  );
  const onClosing = useCallback(() => setMediaPreview(null), []);
  const { pendingCloseTab, closeBusy, closeTabRequest, confirmClose, handleWindowClose } =
    useDocumentClose(session, recovery, doSave, persistWindowState, onClosing);
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
        if (key === 'y' || e.shiftKey) handleRedo();
        else handleUndo();
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
    handleUndo,
    handleRedo,
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
  const view = startupView(startupResolved, tabs.length);

  return (
    <div className="app" data-body-font={bodyFont}>
      <SettingsNotice error={settingsError} onRetry={retrySettings} />
      <Toolbar
        exporting={exporting}
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
        tabs={tabs}
        activeId={activeId}
        onSelect={selectTab}
        onClose={closeTabRequest}
        onNew={() => setNewModalOpen(true)}
        onWheelSwitch={cycleTab}
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
          items={activeTab ? (tabMirror.current[activeId ?? '']?.outline ?? []) : []}
          onJump={jumpToOutline}
        />

        <main
          className="editor-area"
          data-source-mode={sourceMode}
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
                    <button
                      key={f.path}
                      className="welcome-recent-item"
                      onClick={() => void openFileFromPath(f.path)}
                    >
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
                sourceMode={sourceMode}
                onUpdate={handleTabUpdate}
                onRegister={registerEditor}
                onImagePaste={handleImagePaste}
                onMediaPreview={setMediaPreview}
              />
            ))
          )}

          <Presence key={activeId} present={Boolean(activeTab) && searchOpen}>
            <SearchBar
              editor={!sourceMode && activeId ? (editorRegistry.current[activeId] ?? null) : null}
              source={
                sourceMode && activeTab
                  ? {
                      input: sourceRegistry.current[activeTab.id] ?? null,
                      text: resolveContent(activeTab),
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
              imageRewrites={sourceRewrites.current[tab.id]}
              onChange={(text) => handleSourceChange(tab.id, text)}
              onClose={toggleSourceMode}
              onImagePaste={handleImagePaste}
            />
          ))}
        </main>
      </div>

      <StatusBar
        tab={activeTab}
        themeMode={themeMode}
        onThemeMode={changeThemeMode}
        sourceMode={sourceMode}
        saveState={activeSaveState}
        zoom={editorZoom}
        onResetZoom={() => setEditorZoom(100)}
        bodyFont={bodyFont}
        codeFont={codeFont}
        onBodyFont={changeBodyFont}
        onCodeFont={changeCodeFont}
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
          onClose={() => setRecentMenuOpen(false)}
        />
      </Presence>
    </div>
  );
}
