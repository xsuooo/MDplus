import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { Tab } from '../lib/types';
import { TAB_WHEEL_INITIAL, wheelStep, type TabWheelDirection } from '../lib/tabWheel';
import { IconClose } from './icons';
import { displayPath } from '../lib/pathDisplay';
import { formatActionShortcuts, type ShortcutBindings } from '../lib/shortcuts';

interface TabBarProps {
  bindings: ShortcutBindings;
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onWheelSwitch?: (direction: TabWheelDirection) => void;
}

export const TabBar = memo(function TabBar({
  bindings,
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onWheelSwitch,
}: TabBarProps) {
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const barRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const wheelState = useRef({ ...TAB_WHEEL_INITIAL });
  const wheelHandler = useRef(onWheelSwitch);
  const pendingFocus = useRef<{ id: string; frame: number } | null>(null);
  wheelHandler.current = onWheelSwitch;
  const tabCount = tabs.length;
  const newShortcut = formatActionShortcuts(bindings, 'new');

  useLayoutEffect(() => {
    if (pendingFocus.current && pendingFocus.current.id !== activeId) {
      cancelAnimationFrame(pendingFocus.current.frame);
      pendingFocus.current = null;
    }
    const tab = activeId ? tabRefs.current[activeId] : null;
    const strip = stripRef.current;
    if (!tab || !strip) return;
    const box = tab.getBoundingClientRect();
    const visible = strip.getBoundingClientRect();
    const delta =
      box.left < visible.left ? box.left - visible.left : Math.max(0, box.right - visible.right);
    if (delta)
      strip.scrollTo({
        left: strip.scrollLeft + delta,
        behavior: 'instant',
      });
  }, [activeId, tabCount]);

  useEffect(() => {
    const cancelPendingFocus = () => {
      if (!pendingFocus.current) return;
      cancelAnimationFrame(pendingFocus.current.frame);
      pendingFocus.current = null;
    };
    window.addEventListener('pointerdown', cancelPendingFocus, true);
    return () => {
      window.removeEventListener('pointerdown', cancelPendingFocus, true);
      cancelPendingFocus();
    };
  }, []);

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
    if (pendingFocus.current) cancelAnimationFrame(pendingFocus.current.frame);
    pendingFocus.current = {
      id,
      frame: requestAnimationFrame(() => {
        pendingFocus.current = null;
        const tab = tabRefs.current[id];
        if (tab?.getAttribute('aria-selected') === 'true') tab.focus({ preventScroll: true });
      }),
    };
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
      <div className="tabbar-tabs" ref={stripRef}>
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            role="tab"
            className={`tab${tab.id === activeId ? ' active' : ''}`}
            onClick={() => {
              if (pendingFocus.current) {
                cancelAnimationFrame(pendingFocus.current.frame);
                pendingFocus.current = null;
              }
              onSelect(tab.id);
            }}
            ref={(element) => {
              tabRefs.current[tab.id] = element;
            }}
            title={tab.path ? displayPath(tab.path) : tab.title}
            tabIndex={tab.id === activeId ? 0 : -1}
            aria-selected={tab.id === activeId}
            aria-label={`${tab.title}${tab.path ? `,${displayPath(tab.path)}` : ',尚未保存到磁盘'}${tab.dirty || tab.isNew ? ',尚未保存' : ''}${tab.externalChanged ? ',文件已在外部修改' : ''}`}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
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
              <IconClose size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <button
        className="tabbar-new"
        onClick={onNew}
        title={`新建文档${newShortcut ? ` (${newShortcut})` : ''}`}
        aria-label="新建文档"
      >
        +
      </button>
    </div>
  );
});
