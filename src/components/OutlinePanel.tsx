import { memo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { OutlineItem } from '../lib/types';
import {
  OUTLINE_WIDTH_MAX,
  OUTLINE_WIDTH_MIN,
  OUTLINE_WIDTH_STEP,
  normalizeOutlineWidth,
} from '../lib/outlineWidth';
import { IconClose } from './icons';

interface OutlinePanelProps {
  open: boolean;
  onToggle: () => void;
  items: OutlineItem[];
  onJump: (pos: number) => void;
  width: number;
  onWidthChange: (width: number) => void;
}

/** 目录面板:折叠/展开带宽度过渡动画(收起时完全隐藏,仅由工具栏按钮开关) */
export const OutlinePanel = memo(function OutlinePanel({
  open,
  onToggle,
  items,
  onJump,
  width,
  onWidthChange,
}: OutlinePanelProps) {
  const [resizing, setResizing] = useState(false);
  // 拖拽期间用 ref 记录起点,避免每次 pointermove 都重建闭包
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!open || event.button !== 0) return;
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width };
    // 指针捕获失败不应中断拖拽:后续 pointermove 仍然会派发到同一个元素上。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    setResizing(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    onWidthChange(normalizeOutlineWidth(current.startWidth + (event.clientX - current.startX)));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const nudge = (delta: number) => onWidthChange(normalizeOutlineWidth(width + delta));

  const style = { '--outline-width': `${width}px` } as CSSProperties;

  return (
    <aside
      className={`outline${open ? '' : ' collapsed'}${resizing ? ' outline-resizing' : ''}`}
      aria-label="文档目录"
      aria-hidden={!open}
      style={style}
    >
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
      {open && (
        <div
          className="outline-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整目录宽度"
          aria-valuemin={OUTLINE_WIDTH_MIN}
          aria-valuemax={OUTLINE_WIDTH_MAX}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              nudge(-OUTLINE_WIDTH_STEP);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              nudge(OUTLINE_WIDTH_STEP);
            }
          }}
        />
      )}
    </aside>
  );
});
