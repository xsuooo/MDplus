import { useLayoutEffect, useRef, useState } from 'react';
import { fitMedia, type MediaPreview } from '../lib/media';
import { useDialogFocus } from '../lib/useDialogFocus';
import { IconClose } from './icons';
import { isComposingEvent } from '../lib/shortcuts';
import { useIsPresent } from '../lib/presence';

export function MediaViewer({ media, onClose }: { media: MediaPreview; onClose: () => void }) {
  const dialog = useDialogFocus<HTMLDialogElement>(onClose);
  const present = useIsPresent();
  const viewport = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const manual = useRef<number | null>(null);
  const fitted = useRef(1);
  const renderedScale = useRef(zoom ?? fit);
  const scale = present ? (zoom ?? fit) : renderedScale.current;
  const frame = useRef(0);
  const anchor = useRef<{ x: number; y: number; mediaX: number; mediaY: number } | null>(null);
  const previousMedia = useRef<MediaPreview | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    const image = element?.querySelector<HTMLElement>('.media-viewer-content');
    const point = anchor.current;
    if (element && image && point) {
      const bounds = image.getBoundingClientRect();
      element.scrollLeft += bounds.left + point.mediaX * scale - point.x;
      element.scrollTop += bounds.top + point.mediaY * scale - point.y;
    }
    anchor.current = null;
    renderedScale.current = scale;
  }, [scale]);
  const resetZoom = (next: number | null) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    anchor.current = null;
    manual.current = next;
    setZoom(next);
    if (viewport.current) {
      viewport.current.scrollTop = 0;
      viewport.current.scrollLeft = 0;
    }
  };
  const stepZoom = (increase: boolean, point?: { x: number; y: number }) => {
    const current = manual.current ?? fitted.current;
    if (!increase && current <= 0.1) return;
    const next = Math.max(0.1, Math.min(4, increase ? current * 1.25 : current / 1.25));
    if (next === current) return;
    const element = viewport.current;
    const image = element?.querySelector<HTMLElement>('.media-viewer-content');
    if (!anchor.current && element && image) {
      const viewportBounds = element.getBoundingClientRect();
      const bounds = image.getBoundingClientRect();
      const x = point?.x ?? viewportBounds.left + viewportBounds.width / 2;
      const y = point?.y ?? viewportBounds.top + viewportBounds.height / 2;
      anchor.current = {
        x,
        y,
        mediaX: (x - bounds.left) / renderedScale.current,
        mediaY: (y - bounds.top) / renderedScale.current,
      };
    }
    manual.current = next;
    drag.current = null;
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setZoom(manual.current);
      });
  };
  const step = useRef(stepZoom);
  step.current = stepZoom;
  useLayoutEffect(() => {
    if (!present) {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      anchor.current = null;
      dialog.current?.close();
      drag.current = null;
      return;
    }
    if (previousMedia.current !== media) {
      previousMedia.current = media;
      manual.current = null;
      setZoom(null);
      setFailed(false);
    }
    dialog.current?.showModal();
    const element = viewport.current!;
    const measure = () => {
      fitted.current = fitMedia(
        media.width,
        media.height,
        element.clientWidth - 32,
        element.clientHeight - 32,
      );
      setFit(fitted.current);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      if (
        !event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        !Number.isFinite(event.deltaY) ||
        !event.deltaY
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      step.current(event.deltaY < 0, { x: event.clientX, y: event.clientY });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    measure();
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [dialog, media, present]);
  return (
    <dialog
      ref={dialog}
      className="media-viewer"
      {...{ inert: present ? undefined : '' }}
      aria-label={`${media.kind === 'image' ? '图片' : '图表'}查看器`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // Viewer keyboard actions never fall through to document shortcuts.
        event.stopPropagation();
        if (isComposingEvent(event.nativeEvent) || event.altKey || event.metaKey) return;
        if (event.key === '+' || event.key === '=') {
          event.preventDefault();
          stepZoom(true);
        }
        if (event.key === '-' || event.key === '−') {
          event.preventDefault();
          stepZoom(false);
        }
      }}
    >
      <header className="media-viewer-header">
        <h2 title={media.title}>{media.title}</h2>
        <div className="media-viewer-actions">
          <button onClick={() => resetZoom(null)} aria-pressed={zoom === null}>
            适合窗口
          </button>
          <button onClick={() => resetZoom(1)} aria-pressed={zoom === 1}>
            原始大小
          </button>
          <button aria-label="缩小预览" disabled={scale <= 0.1} onClick={() => stepZoom(false)}>
            −
          </button>
          <output aria-label="预览缩放比例">{Math.round(scale * 100)}%</output>
          <button aria-label="放大预览" disabled={scale >= 4} onClick={() => stepZoom(true)}>
            +
          </button>
          <button aria-label="关闭查看器" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </div>
      </header>
      <div
        ref={viewport}
        className="media-viewer-viewport"
        tabIndex={0}
        aria-label="预览画布，可滚动或拖动查看"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const element = event.currentTarget;
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: element.scrollLeft,
            top: element.scrollTop,
          };
          element.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
          event.currentTarget.scrollTop = start.top + start.y - event.clientY;
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {failed ? (
          <p role="alert">
            {media.kind === 'diagram'
              ? '图表预览无法加载。请关闭后检查图表源码，再重试。'
              : '预览无法加载。请关闭后检查图片路径或网络，再重试。'}
          </p>
        ) : (
          <div
            className="media-viewer-content"
            style={{ width: media.width * scale, height: media.height * scale }}
          >
            <img
              src={media.src}
              alt={media.kind === 'diagram' ? '图表放大预览' : media.title}
              draggable={false}
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </div>
      <footer>
        仅查看，不修改文档。Ctrl+滚轮或 Ctrl+加号／减号缩放；可滚动或拖动查看，Esc 返回编辑器。
      </footer>
    </dialog>
  );
}
