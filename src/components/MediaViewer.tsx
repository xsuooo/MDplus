import { useEffect, useRef, useState } from 'react';
import { fitMedia, type MediaPreview } from '../lib/media';
import { useDialogFocus } from '../lib/useDialogFocus';
import { IconClose } from './icons';
import { isComposingEvent } from '../lib/shortcuts';

export function MediaViewer({ media, onClose }: { media: MediaPreview; onClose: () => void }) {
  const dialog = useDialogFocus<HTMLDialogElement>(onClose);
  const viewport = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const scale = zoom ?? fit;
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    const element = viewport.current!;
    const measure = () => setFit(fitMedia(media.width, media.height, element.clientWidth - 32, element.clientHeight - 32));
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, [dialog, media]);
  const changeZoom = (next: number | null) => {
    setZoom(next === null ? null : Math.max(0.1, Math.min(4, next)));
    if (viewport.current) { viewport.current.scrollTop = 0; viewport.current.scrollLeft = 0; }
  };
  return (
    <dialog ref={dialog} className="media-viewer" aria-label={`${media.kind === 'image' ? '图片' : '图表'}查看器`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        // Viewer keyboard actions never fall through to document shortcuts.
        event.stopPropagation();
        if (isComposingEvent(event.nativeEvent)) return;
        if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(scale * 1.25); }
        if (event.key === '-') { event.preventDefault(); if (scale > 0.1) changeZoom(scale / 1.25); }
      }}>
      <header className="media-viewer-header">
        <h2 title={media.title}>{media.title}</h2>
        <div className="media-viewer-actions">
          <button onClick={() => changeZoom(null)} aria-pressed={zoom === null}>适合窗口</button>
          <button onClick={() => changeZoom(1)} aria-pressed={zoom === 1}>原始大小</button>
          <button aria-label="缩小预览" disabled={scale <= 0.1} onClick={() => changeZoom(scale / 1.25)}>−</button>
          <output aria-label="预览缩放比例">{Math.round(scale * 100)}%</output>
          <button aria-label="放大预览" disabled={scale >= 4} onClick={() => changeZoom(scale * 1.25)}>+</button>
          <button aria-label="关闭查看器" onClick={onClose}><IconClose size={18} /></button>
        </div>
      </header>
      <div ref={viewport} className="media-viewer-viewport" tabIndex={0} aria-label="预览画布，可滚动或拖动查看"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const element = event.currentTarget;
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
          element.setPointerCapture(event.pointerId); event.preventDefault();
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
          event.currentTarget.scrollTop = start.top + start.y - event.clientY;
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}>
        {failed ? <p role="alert">{media.kind === 'diagram' ? '图表预览无法加载。请关闭后检查图表源码，再重试。' : '预览无法加载。请关闭后检查图片路径或网络，再重试。'}</p> : (
          <div className="media-viewer-content" style={{ width: media.width * scale, height: media.height * scale }}>
            <img src={media.src} alt={media.kind === 'diagram' ? '图表放大预览' : media.title} draggable={false} onError={() => setFailed(true)} />
          </div>
        )}
      </div>
      <footer>仅查看，不修改文档。原始大小下可滚动或拖动；Esc 返回编辑器。</footer>
    </dialog>
  );
}
