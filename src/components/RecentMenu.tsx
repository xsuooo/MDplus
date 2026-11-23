import { memo } from 'react';
import type { RecentFile } from '../lib/types';
import { IconClock, IconClose } from './icons';
import { useDialogFocus } from '../lib/useDialogFocus';
import { displayPath } from '../lib/paths';

interface RecentMenuProps {
  items: RecentFile[];
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  onClose: () => void;
  restoreSessionEnabled?: boolean;
  onRestoreSessionChange?: (enabled: boolean) => void;
  sessionRestoreBusy?: boolean;
  sessionFailureCount?: number;
  onRetrySession?: () => void;
}

export const RecentMenu = memo(function RecentMenu({
  items,
  onOpen,
  onRemove,
  onClose,
  restoreSessionEnabled = true,
  onRestoreSessionChange,
  sessionRestoreBusy = false,
  sessionFailureCount = 0,
  onRetrySession,
}: RecentMenuProps) {
  const menuRef = useDialogFocus<HTMLDivElement>(onClose);

  return (
    <>
      <div className="menu-mask" onClick={onClose} role="presentation" />
      <div ref={menuRef} className="recent-menu" role="menu" aria-label="最近文件" tabIndex={-1}>
        <div className="recent-menu-header">最近文件</div>
        {items.length === 0 ? (
          <div className="recent-menu-empty">暂无最近文件</div>
        ) : (
          <div className="recent-menu-list">
            {items.map((f) => (
              <div key={f.path} className="recent-menu-row">
                <button
                  className="recent-menu-item"
                  onClick={() => onOpen(f.path)}
                  title={displayPath(f.path)}
                  aria-label={`打开 ${f.name}，${displayPath(f.path)}`}
                  role="menuitem"
                >
                  <IconClock size={14} />
                  <span className="recent-menu-file">
                    <span className="recent-menu-name">{f.name}</span>
                    <span className="recent-menu-path">
                      {displayPath(f.path).replace(/[^\\/]+$/, '')}
                    </span>
                  </span>
                </button>
                <button
                  className="recent-menu-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(f.path);
                  }}
                  title="从最近文件列表移除，不会删除文件"
                  aria-label={`从最近文件移除 ${f.name}，${displayPath(f.path)}；不会删除文件`}
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {onRestoreSessionChange && (
          <div className="recent-session-preference">
            <button
              type="button"
              className="recent-session-setting"
              role="menuitemcheckbox"
              aria-checked={restoreSessionEnabled}
              disabled={sessionRestoreBusy}
              onClick={() => onRestoreSessionChange(!restoreSessionEnabled)}
            >
              <span className="recent-session-check" aria-hidden="true">
                {restoreSessionEnabled ? '✓' : ''}
              </span>
              <span>启动时打开上次的文档</span>
            </button>
            {sessionFailureCount > 0 && onRetrySession && (
              <button
                className="recent-session-retry"
                role="menuitem"
                onClick={onRetrySession}
                disabled={sessionRestoreBusy}
              >
                {sessionRestoreBusy ? '正在重试…' : '重新打开失败的文档'}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
});
