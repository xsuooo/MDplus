import { afterEach, describe, expect, it, vi } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { DecorationSet, type EditorView } from '@milkdown/prose/view';
import { imageView } from '../src/lib/imageView';

class TestElement {
  listeners = new Map<string, EventListener[]>();
  children: TestElement[] = [];
  attributes = new Map<string, string>();
  className = '';
  classList = {
    add: (name: string) => {
      this.className = `${this.className} ${name}`;
    },
    remove: (name: string) => {
      this.className = this.className
        .split(' ')
        .filter((item) => item !== name)
        .join(' ');
    },
  };
  textContent = '';
  contentEditable = '';
  type = '';
  disabled = false;
  hidden = false;
  alt = '';
  title = '';
  get src() {
    return this.attributes.get('src') ?? '';
  }
  set src(value: string) {
    this.attributes.set('src', value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  append(...children: TestElement[]) {
    this.children.push(...children);
  }
  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
}
const schema = new Schema({
  nodes: {
    doc: { content: 'image*' },
    text: {},
    image: { attrs: { src: {}, alt: { default: '' }, title: { default: '' } } },
  },
});
afterEach(() => vi.unstubAllGlobals());

describe('image cache refresh in a NodeView', () => {
  it('leaves active composition to ProseMirror before changing image selection', () => {
    vi.stubGlobal('document', { createElement: () => new TestElement() });
    const view = { isDestroyed: false, composing: true, dispatch: vi.fn(), focus: vi.fn() };
    const nodeView = imageView((src) => src)(
      schema.nodes.image.create({ src: './one.png' }),
      view as unknown as EditorView,
      () => 0,
      [],
      DecorationSet.empty,
    );
    const image = (nodeView.dom as unknown as TestElement).children[0];
    for (const type of ['mousedown', 'click']) {
      const event = new Event(type, { cancelable: true });
      Object.assign(event, { button: 0, ctrlKey: false });
      image.listeners.get(type)!.forEach((listener) => listener(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(view.focus).not.toHaveBeenCalled();
    nodeView.destroy!();
  });
  it('updates only the image DOM, uses the latest node and unsubscribes on destroy', () => {
    vi.stubGlobal('document', { createElement: () => new TestElement() });
    let bytes = 'data:image/png;base64,old';
    const listeners = new Set<() => void>();
    const unsubscribe = vi.fn();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    };
    const view = { isDestroyed: false, dispatch: vi.fn(), focus: vi.fn() };
    const node = schema.nodes.image.create({ src: './one.png', alt: 'one' });
    const nodeView = imageView(
      (src) => (src === './one.png' ? bytes : 'second'),
      undefined,
      subscribe,
    )(node, view as unknown as EditorView, () => 0, [], DecorationSet.empty);
    const image = (nodeView.dom as unknown as TestElement).children[0];
    expect(image.src).toBe(bytes);
    expect(listeners.size).toBe(1);
    bytes = 'data:image/png;base64,new';
    listeners.forEach((notify) => notify());
    expect(image.src).toBe(bytes);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(view.focus).not.toHaveBeenCalled();
    const dom = nodeView.dom as unknown as TestElement;
    expect(dom.children[2].children).toHaveLength(1);
    nodeView.selectNode!();
    expect(dom.className).toContain('ProseMirror-selectednode');
    nodeView.deselectNode!();
    expect(dom.className).not.toContain('ProseMirror-selectednode');
    expect(
      nodeView.update!(
        schema.nodes.image.create({ src: './two.png', alt: 'two' }),
        [],
        DecorationSet.empty,
      ),
    ).toBe(true);
    listeners.forEach((notify) => notify());
    expect(image.src).toBe('second');
    expect(image.alt).toBe('two');
    nodeView.destroy!();
    expect(listeners.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith();
  });
});
