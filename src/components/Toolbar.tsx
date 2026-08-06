import { memo, useState, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  IconOpen,
  IconNew,
  IconSave,
  IconSaveAs,
  IconSearch,
  IconOutline,
  IconCode,
  IconClock,
  IconMinimize,
  IconMaximize,
  IconClose,
  IconExport,
} from './icons';

/** 惰性获取窗口实例;非 Tauri 环境(浏览器预览)返回 null,不影响渲染 */
function appWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

interface ToolbarProps {
  onOpen: () => void;
  onNew: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExportHTML: () => void;
  onExportPDF: () => void;
  hasActiveTab: boolean;
  saving: boolean;
  onSearch: () => void;
  searchOpen: boolean;
  onToggleOutline: () => void;
  outlineOpen: boolean;
  sourceMode: boolean;
  onToggleSource: () => void;
  onRecent: () => void;
  recentOpen: boolean;
  onWindowClose: () => void;
}

export const Toolbar = memo(function Toolbar(props: ToolbarProps) {
  const {
    onOpen,
    onNew,
    onSave,
    onSaveAs,
    onExportHTML,
    onExportPDF,
    hasActiveTab,
    saving,
    onSearch,
    searchOpen,
    onToggleOutline,
    outlineOpen,
    sourceMode,
    onToggleSource,
    onRecent,
    recentOpen,
    onWindowClose,
  } = props;

  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [exportMenuOpen]);

  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="toolbar-brand" title="MDPlus">
        <span className="toolbar-brand-mark">MDPlus</span>
      </div>

      <div className="toolbar-group toolbar-file-actions" aria-label="文件操作">
        <button className="toolbar-btn toolbar-btn-labeled" onClick={onNew} title="新建文档 (Ctrl+N)">
          <IconNew size={16} />
          <span className="toolbar-btn-label">新建</span>
        </button>
        <button className="toolbar-btn toolbar-btn-labeled" onClick={onOpen} title="打开 (Ctrl+O)">
          <IconOpen size={16} />
          <span className="toolbar-btn-label">打开</span>
        </button>
        <button
          className="toolbar-btn toolbar-btn-labeled"
          onClick={onSave}
          title="保存 (Ctrl+S)"
          disabled={!hasActiveTab || saving}
        >
          <IconSave size={16} />
          <span className="toolbar-btn-label">保存</span>
        </button>
        <button
          className="toolbar-btn toolbar-btn-secondary"
          onClick={onSaveAs}
          title="另存为"
          disabled={!hasActiveTab || saving}
        >
          <IconSaveAs size={15} />
          <span className="toolbar-btn-label">另存为</span>
        </button>
        <div className="toolbar-dropdown" ref={exportMenuRef} style={{ pointerEvents: 'auto' }}>
          <button
            className="toolbar-btn toolbar-btn-secondary"
            onClick={() => setExportMenuOpen(!exportMenuOpen)}
            title="导出"
            disabled={!hasActiveTab}
            style={{ pointerEvents: 'auto' }}
          >
            <IconExport size={15} />
            <span className="toolbar-btn-label">导出</span>
          </button>
          {exportMenuOpen && hasActiveTab && (
            <div className="toolbar-dropdown-menu" style={{ pointerEvents: 'auto' }}>
              <button onClick={() => { onExportHTML(); setExportMenuOpen(false); }}>导出为 HTML</button>
              <button onClick={() => { onExportPDF(); setExportMenuOpen(false); }}>导出为 PDF</button>
            </div>
          )}
        </div>
      </div>

      <div className="toolbar-spacer" onDoubleClick={() => void appWindow()?.toggleMaximize()} />

      <div className="toolbar-group">
        <button
          className={`toolbar-btn toolbar-btn-icon${searchOpen ? ' active' : ''}`}
          onClick={onSearch}
          title="当前文档搜索 (Ctrl+F)"
          aria-label="搜索当前文档"
          aria-pressed={searchOpen}
        >
          <IconSearch size={16} />
        </button>
        <button
          className={`toolbar-btn toolbar-btn-icon${outlineOpen ? ' active' : ''}`}
          onClick={onToggleOutline}
          title="目录"
          aria-label="打开目录"
          aria-pressed={outlineOpen}
        >
          <IconOutline size={16} />
        </button>
        <button
          className={`toolbar-btn toolbar-btn-icon${sourceMode ? ' active' : ''}`}
          onClick={onToggleSource}
          title="源码模式"
          aria-label="切换源码模式"
          aria-pressed={sourceMode}
        >
          <IconCode size={16} />
        </button>
        <button
          className={`toolbar-btn toolbar-btn-icon${recentOpen ? ' active' : ''}`}
          onClick={onRecent}
          title="最近打开"
          aria-label="打开最近文件"
          aria-pressed={recentOpen}
        >
          <IconClock size={16} />
        </button>
      </div>

      <div className="toolbar-sep" />

      <div className="window-controls">
        <button className="window-btn" title="最小化" onClick={() => void appWindow()?.minimize()}>
          <IconMinimize size={14} />
        </button>
        <button className="window-btn" title="最大化 / 还原" onClick={() => void appWindow()?.toggleMaximize()}>
          <IconMaximize size={13} />
        </button>
        <button
          className="window-btn window-btn-close"
          title="关闭"
          onClick={onWindowClose}
        >
          <IconClose size={15} />
        </button>
      </div>
    </header>
  );
});
