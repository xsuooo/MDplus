import { Plugin } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { Node } from '@milkdown/prose/model';

function imageParagraphs(doc: Node): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    let hasImage = false;
    let imageOnly = true;
    node.forEach((child) => {
      if (child.type.name === 'image') hasImage = true;
      else if (child.type.name !== 'hardbreak' && !(child.isText && !child.text?.trim())) imageOnly = false;
    });
    if (hasImage && imageOnly) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'md-image-only' }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** Presentation only: never rewrite Markdown to align standalone images. */
export const imageLayoutPlugin = new Plugin<DecorationSet>({
  state: {
    init: (_, state) => imageParagraphs(state.doc),
    apply: (transaction, previous) => transaction.docChanged ? imageParagraphs(transaction.doc) : previous,
  },
  props: {
    decorations(state) { return this.getState(state); },
  },
});
