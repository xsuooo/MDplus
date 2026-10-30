import type { NodeViewConstructor } from '@milkdown/prose/view';
import { NodeSelection } from '@milkdown/prose/state';
import type { MediaPreview } from './media';

export function imageView(resolve: (src: string) => string, onPreview?: (media: MediaPreview) => void): NodeViewConstructor {
  return (node, view, getPos) => {
    const dom = document.createElement('span');
    dom.className = 'md-image-node';
    const image = document.createElement('img');
    const controls = document.createElement('span');
    controls.className = 'md-media-controls';
    controls.contentEditable = 'false';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '放大查看';
    button.setAttribute('aria-label', '放大查看图片');
    button.disabled = true;
    controls.append(button);
    const error = document.createElement('span');
    error.className = 'md-image-error';
    error.hidden = true;
    error.textContent = '图片无法加载，请检查图片路径或网络';
    dom.append(image, error, controls);
    const select = () => {
      const pos = getPos();
      if (pos == null || view.isDestroyed) return;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
      view.focus();
    };
    image.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); select(); });
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      select();
      if (image.naturalWidth > 0) onPreview?.({ kind: 'image', src: image.src, title: image.alt || '图片',
        width: image.naturalWidth, height: image.naturalHeight });
    });
    image.addEventListener('load', () => { error.hidden = true; button.disabled = !onPreview; });
    image.addEventListener('error', () => { error.hidden = false; button.disabled = true; });
    const render = (next: typeof node) => {
      const src = resolve(next.attrs.src);
      if (image.getAttribute('src') !== src) { button.disabled = true; error.hidden = true; image.src = src; }
      image.alt = next.attrs.alt ?? '';
      image.title = next.attrs.title ?? '';
    };
    render(node);
    return {
      dom,
      update(next) { if (next.type !== node.type) return false; render(next); return true; },
      stopEvent: (event) => event.target instanceof Element && !!event.target.closest('.md-media-controls'),
      ignoreMutation: () => true,
    };
  };
}
