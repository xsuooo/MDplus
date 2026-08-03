import { memo } from 'react';
import type { OutlineItem } from '../lib/types';
import { IconClose } from './icons';

interface OutlinePanelProps {
  open: boolean;
  onToggle: () => void;
  items: OutlineItem[];
  onJump: (pos: number) => void;
}

/** 目录面板:折叠/展开带宽度过渡动画(收起时完全隐藏,仅由工具栏按钮开关) */
export const OutlinePanel = memo(function OutlinePanel({ open, onToggle, items, onJump }: OutlinePanelProps) {
  return (
    <aside className={`outline${open ? '' : ' collapsed'}`} aria-label="文档目录" aria-hidden={!open}>
      {open && (
        <button
          className="outline-toggle outline-toggle-raised"
          onClick={onToggle}
          title="收起目录"
          aria-label="收起目录"
        >
          <IconClose size={14} />
        </button>
      )}
      <div className="outline-content">
        <div className="outline-header">
          <span className="outline-title">目录</span>
        </div>
        <div className="outline-body">
          {items.length === 0 ? (
            <div className="outline-empty">暂无标题</div>
          ) : (
            items.map((item, i) => (
              <button
                key={`${item.pos}-${i}`}
                className="outline-item"
                style={{ paddingLeft: 8 + (item.level - 1) * 12 }}
                onClick={() => onJump(item.pos)}
                title={item.text}
                type="button"
              >
                <span className={`outline-bullet lv${item.level}`} />
                <span className="outline-text">{item.text}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </aside>
  );
});
