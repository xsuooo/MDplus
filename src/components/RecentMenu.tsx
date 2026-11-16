import { memo } from 'react';
import type { RecentFile } from '../lib/types';
import { IconClock, IconClose } from './icons';
import { useDialogFocus } from '../lib/useDialogFocus';
import { displayPath } from '../lib/pathDisplay';

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
      <div ref={menuRef} className="recent-menu" role="menu" aria-label="最近打开" tabIndex={-1}>
        <div className="recent-menu-header">最近打开</div>
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
              <span>恢复上次会话</span>
            </button>
            <p>下次启动时继续上次打开的文稿。</p>
            {sessionFailureCount > 0 && onRetrySession && (
              <button
                className="recent-session-retry"
                role="menuitem"
                onClick={onRetrySession}
                disabled={sessionRestoreBusy}
              >
                {sessionRestoreBusy ? '正在重试…' : '重试会话恢复'}
              </button>
            )}
          </div>
        )}
        {items.length === 0 ? (
          <div className="recent-menu-empty">暂无最近打开的文件</div>
        ) : (
          <div className="recent-menu-list">
            {items.map((f) => (
              <div key={f.path} className="recent-menu-row">
                <button
                  className="recent-menu-item"
                  onClick={() => onOpen(f.path)}
                  title={displayPath(f.path)}
                  role="menuitem"
                >
                  <IconClock size={14} />
                  <span className="recent-menu-name">{f.name}</span>
                </button>
                <button
                  className="recent-menu-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(f.path);
                  }}
                  title="从最近列表移除"
                  aria-label={`从最近列表移除 ${f.name}`}
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
});
