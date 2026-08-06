import { memo } from 'react';
import type { Tab, ThemeMode } from '../lib/types';
import { IconSun, IconMoon } from './icons';

interface StatusBarProps {
  tab: Tab | null;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  sourceMode: boolean;
  saveState: 'idle' | 'saving' | 'dirty' | 'saved';
}

export const StatusBar = memo(function StatusBar({
  tab,
  themeMode,
  onThemeMode,
  sourceMode,
  saveState,
}: StatusBarProps) {
  const next: ThemeMode = themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system';
  const saveLabel = saveState === 'saving' ? '保存中…' : saveState === 'dirty' ? '未保存' : '已保存';

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
        </div>
      ) : (
        <div className="statusbar-left" />
      )}

      <div className="statusbar-right">
        <button
          className="statusbar-theme"
          onClick={() => onThemeMode(next)}
          title={`切换主题,当前为${themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '浅色' : '深色'}`}
          aria-label={`切换主题,当前为${themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '浅色' : '深色'}`}
        >
          {themeMode === 'dark' ? <IconMoon size={13} /> : <IconSun size={13} />}
          <span>{themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '浅色' : '深色'}</span>
        </button>
      </div>
    </footer>
  );
});
