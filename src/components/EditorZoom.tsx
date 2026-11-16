import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  bindEditorZoomControls,
  nextEditorZoom,
  readEditorZoom,
  writeEditorZoom,
} from '../lib/editorZoom';

export function EditorZoom({
  area,
  tabId,
  sourceMode,
}: {
  area: RefObject<HTMLElement>;
  tabId: string;
  sourceMode: boolean;
}) {
  const [zoom, setZoom] = useState(readEditorZoom);
  const value = useRef(zoom);
  const reset = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const root = area.current;
    if (!root) {
      reset.current = () => {
        value.current = 100;
        setZoom(100);
        writeEditorZoom(100);
      };
      return;
    }
    let target: HTMLElement | null = null;
    let nativeZoom = value.current;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let anchor: { element: HTMLElement; fraction: number; y: number } | null = null;
    const currentTarget = () =>
      root.querySelector<HTMLElement>(
        sourceMode
          ? '.source-editor:not([hidden]) .source-textarea'
          : '.editor-tab.active .milkdown',
      );
    const commit = () => {
      clearTimeout(timer);
      timer = undefined;
      if (
        nativeZoom === value.current &&
        (!target || (!target.style.transform && target.style.zoom === String(nativeZoom / 100)))
      )
        return;
      if (target) {
        const top = target.scrollTop;
        const height = target.scrollHeight;
        target.style.transform = '';
        target.style.transformOrigin = '';
        target.style.zoom = String(value.current / 100);
        if (target.getClientRects().length) {
          if (sourceMode && height) target.scrollTop = (top * target.scrollHeight) / height;
          else if (anchor?.element.isConnected) {
            const bounds = anchor.element.getBoundingClientRect();
            const scroller = target.closest<HTMLElement>('.milkdown-container');
            if (scroller)
              scroller.scrollTop += bounds.top + bounds.height * anchor.fraction - anchor.y;
          }
        }
      }
      anchor = null;
      nativeZoom = value.current;
      writeEditorZoom(value.current);
    };
    const connect = () => {
      const next = currentTarget();
      if (next === target) return;
      if (target) commit();
      target = next;
      if (target && target.style.zoom !== String(value.current / 100))
        target.style.zoom = String(value.current / 100);
      nativeZoom = value.current;
    };
    connect();
    const observer = new MutationObserver(connect);
    observer.observe(root, { childList: true, subtree: true });
    const unbind = bindEditorZoomControls(root, (action, event) => {
      const next = nextEditorZoom(value.current, action);
      if (next === value.current) return;
      value.current = next;
      connect();
      if (target && !timer && !frame) {
        const bounds = target.getBoundingClientRect();
        const viewport = (
          target.closest<HTMLElement>('.milkdown-container') ?? target
        ).getBoundingClientRect();
        const x =
          event instanceof WheelEvent &&
          event.clientX > viewport.left &&
          event.clientX < viewport.right
            ? event.clientX
            : viewport.left + viewport.width / 2;
        const y =
          event instanceof WheelEvent &&
          event.clientY > viewport.top &&
          event.clientY < viewport.bottom
            ? event.clientY
            : viewport.top + viewport.height / 2;
        target.style.transformOrigin = `${(x - bounds.left) / (nativeZoom / 100)}px ${(y - bounds.top) / (nativeZoom / 100)}px`;
        const element = root.ownerDocument
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>('.md-image-node, p, h1, h2, h3, h4, h5, h6');
        if (element && root.contains(element)) {
          const rect = element.getBoundingClientRect();
          if (rect.height) anchor = { element, fraction: (y - rect.top) / rect.height, y };
        }
      }
      clearTimeout(timer);
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          setZoom(value.current);
          // shortcut: keep old line wrapping during a gesture, use virtualized layout if the final reflow stays slow.
          if (target) target.style.transform = `scale(${value.current / nativeZoom})`;
          timer = setTimeout(commit, 120);
        });
    });
    const flush = () => {
      if (!frame && !timer) return;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      setZoom(value.current);
      commit();
    };
    const view = root.ownerDocument.defaultView;
    const interactions = ['pointerdown', 'keydown', 'compositionstart', 'blur'] as const;
    for (const type of interactions) view?.addEventListener(type, flush, true);
    root.addEventListener('wheel', flush, { capture: true, passive: true });
    root.addEventListener('drop', flush, true);
    reset.current = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      value.current = 100;
      setZoom(100);
      commit();
    };
    return () => {
      unbind();
      for (const type of interactions) view?.removeEventListener(type, flush, true);
      root.removeEventListener('wheel', flush, true);
      root.removeEventListener('drop', flush, true);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      commit();
    };
  }, [area, tabId, sourceMode]);
  return (
    <button
      className="statusbar-theme statusbar-zoom"
      onClick={() => reset.current()}
      title="重置编辑器缩放为100%"
      aria-label={`编辑器缩放${zoom}%,点击重置为100%`}
    >
      {zoom}%
    </button>
  );
}
