import { memo, useEffect, useRef } from 'react';
import type { Tab } from '../lib/types';
import { TAB_WHEEL_INITIAL, wheelStep, type TabWheelDirection } from '../lib/tabWheel';
import { IconClose } from './icons';

interface TabBarProps {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onWheelSwitch?: (direction: TabWheelDirection) => void;
}

export const TabBar = memo(function TabBar({ tabs, activeId, onSelect, onClose, onNew, onWheelSwitch }: TabBarProps) {
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const barRef = useRef<HTMLDivElement | null>(null);
  const wheelState = useRef({ ...TAB_WHEEL_INITIAL });
  const wheelHandler = useRef(onWheelSwitch);
  wheelHandler.current = onWheelSwitch;
  const tabCount = tabs.length;

  // 滚轮监听需要 passive: false 才能阻止页面滚动,而 React 的 onWheel 是 passive 的,
  // 所以这里自己挂原生监听。
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const onWheel = (event: WheelEvent) => {
      const handler = wheelHandler.current;
      if (!handler) return;
      const result = wheelStep(wheelState.current, event, tabCount, Date.now());
      wheelState.current = result.state;
      if (result.direction === 0) return;
      event.preventDefault();
      handler(result.direction);
    };
    bar.addEventListener('wheel', onWheel, { passive: false });
    return () => bar.removeEventListener('wheel', onWheel);
  }, [tabCount]);

  const focusTab = (id: string) => {
    requestAnimationFrame(() => tabRefs.current[id]?.focus());
  };

  const selectRelative = (index: number, offset: number) => {
    const nextIndex = (index + offset + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (next) {
      onSelect(next.id);
      focusTab(next.id);
    }
  };

  return (
    <div className="tabbar" role="tablist" aria-label="打开的文档" ref={barRef}>
      <div className="tabbar-tabs">
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            role="tab"
            className={`tab${tab.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(tab.id)}
            ref={(element) => {
              tabRefs.current[tab.id] = element;
            }}
            title={tab.path ?? tab.title}
            tabIndex={tab.id === activeId ? 0 : -1}
            aria-selected={tab.id === activeId}
            aria-label={`${tab.title}${tab.dirty || tab.isNew ? ',尚未保存' : ''}${tab.externalChanged ? ',文件已在外部修改' : ''}`}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(tab.id);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                selectRelative(index, 1);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                selectRelative(index, -1);
              } else if (event.key === 'Home' && tabs[0]) {
                event.preventDefault();
                onSelect(tabs[0].id);
                focusTab(tabs[0].id);
              } else if (event.key === 'End' && tabs[tabs.length - 1]) {
                event.preventDefault();
                onSelect(tabs[tabs.length - 1].id);
                focusTab(tabs[tabs.length - 1].id);
              }
            }}
          >
            <span
              className="tab-dot"
              data-dirty={tab.dirty || tab.isNew ? '1' : '0'}
              data-external={tab.externalChanged ? '1' : '0'}
              title={tab.externalChanged ? '文件已在外部修改' : undefined}
            />
            <span className="tab-title">{tab.title}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              title={`关闭 ${tab.title}`}
              aria-label={`关闭 ${tab.title}`}
            >
              <IconClose size={12} />
            </button>
          </div>
        ))}
      </div>
      <button className="tabbar-new" onClick={onNew} title="新建文档 (Ctrl+N)" aria-label="新建文档">
        +
      </button>
    </div>
  );
});
