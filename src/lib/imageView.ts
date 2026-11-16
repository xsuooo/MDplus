import type { NodeViewConstructor } from '@milkdown/prose/view';
import { NodeSelection, TextSelection } from '@milkdown/prose/state';
import type { MediaPreview } from './media';

export function imageView(
  resolve: (src: string) => string,
  onPreview?: (media: MediaPreview) => void,
  subscribe?: (listener: () => void) => () => void,
): NodeViewConstructor {
  return (node, view, getPos) => {
    let currentNode = node;
    let destroyed = false;
    let dragged = false;
    let stopDrag: (() => void) | undefined;
    const dom = document.createElement('span');
    dom.className = 'md-image-node';
    const image = document.createElement('img');
    image.decoding = 'async';
    image.draggable = false;
    const controls = document.createElement('span');
    controls.className = 'md-media-controls';
    controls.contentEditable = 'false';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '放大查看';
    button.setAttribute('aria-label', '放大查看图片');
    button.disabled = true;
    button.title = '也可双击图片放大查看';
    controls.append(button);
    const error = document.createElement('span');
    error.className = 'md-image-error';
    error.hidden = true;
    error.textContent =
      '图片无法加载，请检查文稿目录内的图片路径。当前不支持网络图片，请先下载后粘贴、拖入或选择本地图片。';
    dom.append(image, error, controls);
    const select = () => {
      const pos = getPos();
      if (pos == null || view.isDestroyed) return;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
      view.focus();
    };
    const followsLink = (event: MouseEvent) =>
      event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.metaKey &&
      image.closest('a[href]');
    image.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || followsLink(event) || view.composing) return;
      const pos = getPos();
      if (pos == null || view.isDestroyed) return;
      stopDrag?.();
      dragged = false;
      // Native image dragging otherwise takes over the document's range selection.
      event.preventDefault();
      event.stopPropagation();
      const selected = view.state.selection;
      const anchor = event.shiftKey
        ? selected instanceof NodeSelection && pos < selected.anchor
          ? selected.to
          : selected.anchor
        : pos;
      if (event.shiftKey)
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(
              view.state.doc,
              anchor,
              pos < anchor ? pos : pos + currentNode.nodeSize,
            ),
          ),
        );
      else select();
      const doc = image.ownerDocument;
      let frame = 0;
      let point = { x: event.clientX, y: event.clientY };
      const extend = () => {
        frame = 0;
        if (
          destroyed ||
          view.isDestroyed ||
          view.dom.closest('[inert]') ||
          !view.dom.getClientRects().length
        ) {
          stopDrag?.();
          return;
        }
        const scroller = view.dom.closest<HTMLElement>('.milkdown-container');
        const bounds = scroller?.getBoundingClientRect();
        const step =
          bounds && (point.y < bounds.top + 24 ? -16 : point.y > bounds.bottom - 24 ? 16 : 0);
        if (step && scroller) scroller.scrollTop += step;
        const hit = view.posAtCoords({
          left: point.x,
          top: bounds ? Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, point.y)) : point.y,
        });
        if (hit) {
          const base = event.shiftKey
            ? view.state.selection.anchor
            : (getPos() ?? view.state.selection.anchor);
          const target = hit.inside >= 0 ? view.state.doc.nodeAt(hit.inside) : null;
          const end =
            target?.type.name === 'image'
              ? hit.inside + (hit.inside < base ? 0 : target.nodeSize)
              : hit.pos;
          const start = !event.shiftKey && end < base ? base + currentNode.nodeSize : base;
          const selection = TextSelection.create(view.state.doc, start, end);
          if (!selection.eq(view.state.selection))
            view.dispatch(view.state.tr.setSelection(selection));
        }
        if (step) frame = requestAnimationFrame(extend);
      };
      const move = (next: MouseEvent) => {
        if (next.buttons !== 1) {
          stopDrag?.();
          return;
        }
        if (!dragged && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 4)
          return;
        dragged = true;
        point = { x: next.clientX, y: next.clientY };
        if (!frame) frame = requestAnimationFrame(extend);
      };
      const finish = () => {
        if (frame && dragged) {
          cancelAnimationFrame(frame);
          extend();
        }
        stopDrag?.();
      };
      stopDrag = () => {
        doc.removeEventListener('mousemove', move);
        doc.removeEventListener('mouseup', finish);
        doc.defaultView?.removeEventListener('blur', finish);
        if (frame) cancelAnimationFrame(frame);
        stopDrag = undefined;
      };
      doc.addEventListener('mousemove', move);
      doc.addEventListener('mouseup', finish);
      doc.defaultView?.addEventListener('blur', finish);
    });
    image.addEventListener('click', (event) => {
      if (followsLink(event) || (dragged && event.detail > 0) || event.shiftKey || view.composing)
        return;
      event.preventDefault();
      event.stopPropagation();
      select();
    });
    const preview = () => {
      if (!button.disabled && image.naturalWidth > 0)
        onPreview?.({
          kind: 'image',
          src: image.src,
          title: image.alt || '图片',
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
    };
    image.addEventListener('dblclick', (event) => {
      if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      preview();
    });
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      select();
      preview();
    });
    image.addEventListener('load', () => {
      error.hidden = true;
      button.disabled = !onPreview;
    });
    image.addEventListener('error', () => {
      error.hidden = false;
      button.disabled = true;
    });
    const render = (next: typeof node) => {
      const src = resolve(next.attrs.src);
      if (image.getAttribute('src') !== src) {
        button.disabled = true;
        error.hidden = true;
        image.src = src;
      }
      image.alt = next.attrs.alt ?? '';
      image.title = next.attrs.title ?? '';
    };
    render(node);
    const unsubscribe = subscribe?.(() => {
      if (!destroyed && !view.isDestroyed) render(currentNode);
    });
    return {
      dom,
      selectNode() {
        dom.classList.add('ProseMirror-selectednode');
      },
      deselectNode() {
        dom.classList.remove('ProseMirror-selectednode');
      },
      update(next) {
        if (next.type !== currentNode.type) return false;
        currentNode = next;
        render(next);
        return true;
      },
      destroy() {
        destroyed = true;
        stopDrag?.();
        unsubscribe?.();
      },
      stopEvent: (event) =>
        event.target instanceof Element && !!event.target.closest('.md-media-controls'),
      ignoreMutation: () => true,
    };
  };
}
