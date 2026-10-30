import { memo } from 'react';
import type { Tab, ThemeMode } from '../lib/types';
import { IconSun, IconMoon, IconMonitor } from './icons';
import type { BodyFont, CodeFont } from '../lib/editorFont';
import { TypographyPanel } from './TypographyPanel';
import type { RecoveryStatus } from '../lib/recovery';

interface StatusBarProps {
  tab: Tab | null;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  sourceMode: boolean;
  saveState: 'idle' | 'saving' | 'unsaved' | 'dirty' | 'saved';
  zoom: number;
  onResetZoom: () => void;
  bodyFont: BodyFont;
  codeFont: CodeFont;
  onBodyFont: (font: BodyFont) => void;
  onCodeFont: (font: CodeFont) => void;
  recoveryStatus?: RecoveryStatus;
  onRecovery?: () => void;
}

export const StatusBar = memo(function StatusBar({
  tab,
  themeMode,
  onThemeMode,
  sourceMode,
  saveState,
  zoom,
  onResetZoom,
  bodyFont,
  codeFont,
  onBodyFont,
  onCodeFont,
  recoveryStatus,
  onRecovery,
}: StatusBarProps) {
  const next: ThemeMode = themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system';
  const saveLabel =
    saveState === 'saving'
      ? '保存中…'
      : saveState === 'unsaved'
        ? '待另存为'
        : saveState === 'dirty'
          ? '未保存'
          : '已保存';

  return (
    <footer className="statusbar">
      {tab ? (
        <div className="statusbar-left">
          <span className="status-item">{tab.stats.words} 词</span>
          <span className="status-sep">·</span>
          <span className="status-item">{tab.stats.chars} 字符</span>
          <span className="status-sep">·</span>
          <span className="status-item">{tab.stats.lines} 行</span>
          <span className="status-sep">·</span>
          <span className={`status-item status-save status-save-${saveState}${saveState === 'dirty' ? ' dirty' : ''}`}>
            {saveLabel}
          </span>
          <span className="status-sep">·</span>
          <span className="status-item">{sourceMode ? '源码模式' : '编辑模式'}</span>
          {recoveryStatus && recoveryStatus !== 'idle' && (
            <span className={`status-item recovery-status-${recoveryStatus}`} role="status"
              title="本机恢复副本不是正式保存。包含原文和图片，未加密。">
              {recoveryStatus === 'error' ? '恢复保护失败，请手动保存' : recoveryStatus === 'pending' ? '恢复保护中…' : '本机副本已保护'}
            </span>
          )}
        </div>
      ) : (
        <div className="statusbar-left" />
      )}

      <div className="statusbar-right">
        {onRecovery && <button className="statusbar-theme" onClick={onRecovery} title="恢复草稿与清理缓存">恢复草稿</button>}
        <TypographyPanel bodyFont={bodyFont} codeFont={codeFont} onBodyFont={onBodyFont} onCodeFont={onCodeFont} />
        {tab && (
          <button
            className="statusbar-theme statusbar-zoom"
            onClick={onResetZoom}
            title="重置编辑器缩放为100%"
            aria-label={`编辑器缩放${zoom}%,点击重置为100%`}
          >
            {zoom}%
          </button>
        )}
        <button
          className="statusbar-theme"
          onClick={() => onThemeMode(next)}
          title={`切换主题,当前为${themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '浅色' : '深色'}`}
          aria-label={`切换主题,当前为${themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '浅色' : '深色'}`}
        >
          {themeMode === 'dark' ? <IconMoon size={13} /> : themeMode === 'system' ? <IconMonitor size={13} /> : <IconSun size={13} />}
          <span>{themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '浅色' : '深色'}</span>
        </button>
      </div>
    </footer>
  );
});
