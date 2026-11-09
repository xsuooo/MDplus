import { Plugin, Selection } from '@milkdown/prose/state';
import { ImageSelection } from './imageSelection';

export const imageMarqueePlugin = new Plugin({
  view(view) {
    const scroller = view.dom.closest<HTMLElement>('.milkdown-container');
    if (!scroller) return {};
    const doc = view.dom.ownerDocument;
    let stop: (() => void) | undefined;
    let swallowClick = false;

    const start = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        event.pointerType !== 'mouse' ||
        event.altKey ||
        view.composing ||
        view.isDestroyed ||
        scroller.closest('[inert]') ||
        !(event.target instanceof Element) ||
        event.target.closest(
          'a, button, input, textarea, select, .md-image-node, .md-code-block, .md-mermaid-node',
        )
      )
        return;
      // Preserve ordinary text dragging when the pointer starts on an actual glyph.
      const caret = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (
        caret?.startContainer.nodeType === Node.TEXT_NODE &&
        view.dom.contains(caret.startContainer)
      ) {
        const text = caret.startContainer;
        const offset = caret.startOffset;
        caret.setStart(text, Math.max(0, offset - 1));
        caret.setEnd(text, Math.min(text.textContent?.length ?? 0, offset + 1));
        if (
          [...caret.getClientRects()].some(
            (rect) =>
              event.clientX >= rect.left &&
              event.clientX <= rect.right &&
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom,
          )
        )
          return;
      }
      const viewport = scroller.getBoundingClientRect();
      if (
        event.clientX >= viewport.left + scroller.clientWidth ||
        event.clientY >= viewport.top + scroller.clientHeight
      )
        return;
      stop?.();
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
      const original = view.state;
      const scale = viewport.height / scroller.clientHeight || 1;
      const origin = {
        x: event.clientX - viewport.left + scroller.scrollLeft * scale,
        y: event.clientY - viewport.top + scroller.scrollTop * scale,
      };
      const candidates: {
        pos: number;
        left: number;
        top: number;
        right: number;
        bottom: number;
      }[] = [];
      original.doc.descendants((node, pos) => {
        if (node.type.name !== 'image') return;
        const dom = view.nodeDOM(pos) as HTMLElement | null;
        const rect = (dom?.querySelector('img') ?? dom)?.getBoundingClientRect();
        if (!rect?.width || !rect.height) return;
        candidates.push({
          pos,
          left: rect.left - viewport.left + scroller.scrollLeft * scale,
          right: rect.right - viewport.left + scroller.scrollLeft * scale,
          top: rect.top - viewport.top + scroller.scrollTop * scale,
          bottom: rect.bottom - viewport.top + scroller.scrollTop * scale,
        });
      });
      const added =
        event.ctrlKey || event.shiftKey
          ? candidates
              .filter(({ pos }) =>
                original.selection.ranges.some(
                  (range) => range.$from.pos <= pos && range.$to.pos > pos,
                ),
              )
              .map(({ pos }) => pos)
          : [];
      const rectangle = doc.createElement('div');
      rectangle.className = 'md-image-marquee';
      rectangle.setAttribute('aria-hidden', 'true');
      let point = { x: event.clientX, y: event.clientY };
      let frame = 0;
      let dragged = false;
      const cursor = () => {
        const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
        return Selection.near(view.state.doc.resolve(hit?.pos ?? original.selection.head));
      };
      const extend = () => {
        frame = 0;
        if (view.isDestroyed || view.state.doc !== original.doc || scroller.closest('[inert]')) {
          stop?.();
          return;
        }
        const step = point.y < viewport.top + 24 ? -16 : point.y > viewport.bottom - 24 ? 16 : 0;
        if (step) scroller.scrollTop += step;
        const x =
          Math.max(viewport.left, Math.min(viewport.right, point.x)) -
          viewport.left +
          scroller.scrollLeft * scale;
        const y =
          Math.max(viewport.top, Math.min(viewport.bottom, point.y)) -
          viewport.top +
          scroller.scrollTop * scale;
        const left = Math.min(origin.x, x),
          right = Math.max(origin.x, x);
        const top = Math.min(origin.y, y),
          bottom = Math.max(origin.y, y);
        const scrollX = scroller.scrollLeft * scale,
          scrollY = scroller.scrollTop * scale;
        const visibleLeft = Math.max(viewport.left, viewport.left + left - scrollX);
        const visibleTop = Math.max(viewport.top, viewport.top + top - scrollY);
        Object.assign(rectangle.style, {
          left: `${visibleLeft}px`,
          top: `${visibleTop}px`,
          width: `${Math.max(0, Math.min(viewport.right, viewport.left + right - scrollX) - visibleLeft)}px`,
          height: `${Math.max(0, Math.min(viewport.bottom, viewport.top + bottom - scrollY) - visibleTop)}px`,
        });
        const positions = candidates
          .filter(
            (rect) =>
              rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top,
          )
          .map(({ pos }) => pos);
        const selection =
          positions.length || added.length
            ? ImageSelection.create(original.doc, [...added, ...positions])
            : cursor();
        if (!selection.eq(view.state.selection))
          view.dispatch(view.state.tr.setSelection(selection));
        if (step) frame = requestAnimationFrame(extend);
      };
      const move = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        if (next.buttons !== 1) {
          cancel();
          return;
        }
        point = { x: next.clientX, y: next.clientY };
        if (!dragged && Math.hypot(point.x - event.clientX, point.y - event.clientY) < 4) return;
        if (!dragged) {
          dragged = true;
          doc.body.append(rectangle);
        }
        if (!frame) frame = requestAnimationFrame(extend);
      };
      const finish = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        if (view.isDestroyed || view.state.doc !== original.doc || scroller.closest('[inert]')) {
          cancel();
          return;
        }
        point = { x: next.clientX, y: next.clientY };
        if (frame) cancelAnimationFrame(frame);
        if (dragged) extend();
        else if (!view.isDestroyed) view.dispatch(view.state.tr.setSelection(cursor()));
        swallowClick = dragged;
        stop?.();
        if (!view.isDestroyed) view.focus();
      };
      const cancel = () => {
        stop?.();
        if (!view.isDestroyed && view.state.doc === original.doc)
          view.dispatch(view.state.tr.setSelection(original.selection));
      };
      const key = (next: KeyboardEvent) => {
        if (next.key === 'Escape' && !next.isComposing) {
          next.preventDefault();
          next.stopPropagation();
          cancel();
        }
      };
      const visibility = new MutationObserver(() => {
        if (scroller.closest('[inert]')) cancel();
      });
      const tab = scroller.closest('.editor-tab');
      if (tab) visibility.observe(tab, { attributes: true, attributeFilter: ['inert'] });
      stop = () => {
        if (frame) cancelAnimationFrame(frame);
        visibility.disconnect();
        rectangle.remove();
        doc.removeEventListener('pointermove', move, true);
        doc.removeEventListener('pointerup', finish, true);
        doc.removeEventListener('pointercancel', cancel, true);
        doc.defaultView?.removeEventListener('keydown', key, true);
        doc.defaultView?.removeEventListener('blur', cancel);
        stop = undefined;
      };
      doc.addEventListener('pointermove', move, true);
      doc.addEventListener('pointerup', finish, true);
      doc.addEventListener('pointercancel', cancel, true);
      doc.defaultView?.addEventListener('keydown', key, true);
      doc.defaultView?.addEventListener('blur', cancel);
    };
    const click = (event: MouseEvent) => {
      if (swallowClick && event.detail > 0) {
        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    scroller.addEventListener('pointerdown', start, true);
    scroller.addEventListener('click', click, true);
    return {
      update() {
        if (view.isDestroyed || scroller.closest('[inert]')) stop?.();
      },
      destroy() {
        stop?.();
        scroller.removeEventListener('pointerdown', start, true);
        scroller.removeEventListener('click', click, true);
      },
    };
  },
});
