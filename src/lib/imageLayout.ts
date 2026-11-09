import { Plugin } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { Node } from '@milkdown/prose/model';
import { createNodeIndex } from './documentNodes';

const paragraphNodes = createNodeIndex('paragraph');
const imageOnly = new WeakMap<Node, boolean>();

function imageParagraphs(doc: Node): DecorationSet {
  const decorations: Decoration[] = [];
  for (const { node, pos } of paragraphNodes(doc)) {
    let standalone = imageOnly.get(node);
    if (standalone === undefined) {
      let hasImage = false;
      standalone = true;
      node.forEach((child) => {
        if (child.type.name === 'image') hasImage = true;
        else if (child.type.name !== 'hardbreak' && !(child.isText && !child.text?.trim()))
          standalone = false;
      });
      standalone = hasImage && standalone;
      imageOnly.set(node, standalone);
    }
    if (standalone)
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'md-image-only' }));
  }
  return DecorationSet.create(doc, decorations);
}

/** Presentation only: never rewrite Markdown to align standalone images. */
export const imageLayoutPlugin = new Plugin<DecorationSet>({
  state: {
    init: (_, state) => imageParagraphs(state.doc),
    apply: (transaction, previous) =>
      transaction.docChanged ? imageParagraphs(transaction.doc) : previous,
  },
  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});

export const imageSelectionPlugin = new Plugin<DecorationSet>({
  state: {
    init: () => DecorationSet.empty,
    apply: (transaction, previous) => {
      if (!transaction.docChanged && !transaction.selectionSet) return previous;
      const { ranges, empty } = transaction.selection;
      if (empty) return DecorationSet.empty;
      const decorations: Decoration[] = [];
      for (const { $from, $to } of ranges)
        transaction.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
          if (node.type.name === 'image' && pos >= $from.pos && pos + node.nodeSize <= $to.pos)
            decorations.push(
              Decoration.node(pos, pos + node.nodeSize, { class: 'md-image-selected' }),
            );
        });
      return DecorationSet.create(transaction.doc, decorations);
    },
  },
  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});
