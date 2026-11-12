import { memo, type RefObject } from 'react';
import { EditorZoom } from './EditorZoom';
import type { Tab, ThemeMode } from '../lib/types';
import { IconSun, IconMoon, IconMonitor, IconClock } from './icons';
import type { BodyFont, CodeFont } from '../lib/editorFont';
import type { EditorWidth } from '../lib/editorWidth';
import { TypographyPanel } from './TypographyPanel';
import type { RecoveryStatus } from '../lib/recovery';
import { APP_VERSION_DETAILS, APP_VERSION_LABEL } from '../lib/appVersion';
import { displayPath } from '../lib/pathDisplay';
import { formatActionShortcuts, type ShortcutBindings } from '../lib/shortcuts';

interface StatusBarProps {
  bindings: ShortcutBindings;
  tab: Tab | null;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  sourceMode: boolean;
  saveState: 'idle' | 'saving' | 'unsaved' | 'dirty' | 'saved' | 'paused';
  editorAreaRef: RefObject<HTMLElement>;
  bodyFont: BodyFont;
  codeFont: CodeFont;
  onBodyFont: (font: BodyFont) => void;
  onCodeFont: (font: CodeFont) => void;
  editorWidth: EditorWidth;
  onEditorWidth: (width: EditorWidth) => void;
  recoveryStatus?: RecoveryStatus;
  onRecovery?: () => void;
}

export const StatusBar = memo(function StatusBar({
  bindings,
  tab,
  themeMode,
  onThemeMode,
  sourceMode,
  saveState,
  editorAreaRef,
  bodyFont,
  codeFont,
  onBodyFont,
  onCodeFont,
  editorWidth,
  onEditorWidth,
  recoveryStatus,
  onRecovery,
}: StatusBarProps) {
  const saveShortcut = formatActionShortcuts(bindings, 'save');
  const saveAction = saveShortcut ? `按 ${saveShortcut}` : '点击工具栏「保存」';
  const next: ThemeMode =
    themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system';
  const displaySaveState =
    tab && !tab.path && saveState !== 'saving' && saveState !== 'paused'
      ? 'unsaved'
      : saveState === 'idle' && tab
        ? tab.dirty
          ? 'dirty'
          : 'saved'
        : saveState;
  const saveLabel =
    displaySaveState === 'saving'
      ? '保存中…'
      : displaySaveState === 'paused'
        ? '自动保存已暂停'
        : displaySaveState === 'unsaved' || displaySaveState === 'dirty'
          ? '未保存'
          : '已保存';
  const saveTitle =
    displaySaveState === 'paused'
      ? `自动保存已暂停。${saveAction}核对磁盘版本，或另存为保留两份。`
      : displaySaveState === 'unsaved'
        ? `${saveAction}为文稿选择保存位置。`
        : displaySaveState === 'dirty'
          ? '更改尚未写入文件。'
          : undefined;
  const showRecovery =
    recoveryStatus &&
    recoveryStatus !== 'idle' &&
    (recoveryStatus !== 'protected' ||
      (displaySaveState !== 'saved' && displaySaveState !== 'idle'));
  const themeLabel = themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '浅色' : '深色';

  return (
    <footer className="statusbar" aria-label="文稿状态栏">
      <div className="statusbar-left">
        {tab && (
          <>
            <div className="statusbar-group statusbar-document">
              <span
                className={`status-item status-save status-save-${displaySaveState}${displaySaveState === 'dirty' ? ' dirty' : ''}`}
                role="status"
                title={saveTitle}
              >
                <span className="status-save-dot" aria-hidden="true" />
                {saveLabel}
              </span>
              {showRecovery && (
                <span
                  className={`status-item status-recovery recovery-status-${recoveryStatus}`}
                  role="status"
                  title={
                    recoveryStatus === 'error'
                      ? `恢复副本写入失败，请${saveAction}手动保存文稿。`
                      : '本机恢复副本包含文稿和图片，未加密；不等于正式保存。'
                  }
                >
                  {recoveryStatus === 'error'
                    ? '草稿保护失败'
                    : recoveryStatus === 'pending'
                      ? '草稿保护中…'
                      : '草稿已保护'}
                </span>
              )}
            </div>
            <div className="statusbar-group statusbar-details">
              <span className="status-metrics" title="文稿统计">
                <span className="status-item status-metric-words">{tab.stats.words} 词</span>
                <span className="status-item status-metric-chars">{tab.stats.chars} 字符</span>
                <span className="status-item status-metric-lines">{tab.stats.lines} 行</span>
              </span>
            </div>
            <div className="statusbar-group statusbar-location">
              <span
                className="status-item status-mode"
                title={sourceMode ? '源码模式' : '编辑模式'}
              >
                {sourceMode ? '源码' : '编辑'}
              </span>
              {tab.path && (
                <span className="status-item status-file-identity" title={displayPath(tab.path)}>
                  {displayPath(tab.path)}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="statusbar-right">
        <div className="statusbar-group statusbar-actions" role="group" aria-label="文稿与外观选项">
          {onRecovery && (
            <button
              className="statusbar-theme statusbar-recovery-action"
              onClick={onRecovery}
              title="恢复草稿与清理缓存"
              aria-label="恢复草稿"
            >
              <IconClock size={13} aria-hidden="true" />
              <span className="statusbar-label">恢复</span>
            </button>
          )}
          <TypographyPanel
            bodyFont={bodyFont}
            codeFont={codeFont}
            onBodyFont={onBodyFont}
            onCodeFont={onCodeFont}
            editorWidth={editorWidth}
            onEditorWidth={onEditorWidth}
          />
          {tab && <EditorZoom area={editorAreaRef} tabId={tab.id} sourceMode={sourceMode} />}
          <button
            className="statusbar-theme"
            onClick={() => onThemeMode(next)}
            title={`切换主题,当前为${themeLabel}`}
            aria-label={`切换主题,当前为${themeLabel}`}
          >
            {themeMode === 'dark' ? (
              <IconMoon size={13} aria-hidden="true" />
            ) : themeMode === 'system' ? (
              <IconMonitor size={13} aria-hidden="true" />
            ) : (
              <IconSun size={13} aria-hidden="true" />
            )}
            <span className="statusbar-label">{themeLabel}</span>
          </button>
        </div>
        <span
          className="statusbar-version"
          role="note"
          title={APP_VERSION_DETAILS}
          aria-label={APP_VERSION_DETAILS}
          tabIndex={0}
        >
          {APP_VERSION_LABEL}
        </span>
      </div>
    </footer>
  );
});
