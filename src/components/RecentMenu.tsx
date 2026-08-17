import { memo } from 'react';
import type { RecentFile } from '../lib/types';
import { IconClock, IconClose } from './icons';
import { useDialogFocus } from '../lib/useDialogFocus';

interface RecentMenuProps {
  items: RecentFile[];
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  onClose: () => void;
}

export const RecentMenu = memo(function RecentMenu({ items, onOpen, onRemove, onClose }: RecentMenuProps) {
  const menuRef = useDialogFocus<HTMLDivElement>(onClose);

  return (
    <>
      <div className="menu-mask" onClick={onClose} role="presentation" />
      <div ref={menuRef} className="recent-menu" role="menu" aria-label="最近打开" tabIndex={-1}>
        <div className="recent-menu-header">最近打开</div>
        {items.length === 0 ? (
          <div className="recent-menu-empty">暂无最近打开的文件</div>
        ) : (
          <div className="recent-menu-list">
            {items.map((f) => (
              <div key={f.path} className="recent-menu-row">
                <button
                  className="recent-menu-item"
                  onClick={() => onOpen(f.path)}
                  title={f.path}
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
