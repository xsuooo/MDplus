import type { Node } from '@milkdown/prose/model';

interface PositionedNode {
  node: Node;
  pos: number;
}

/** Immutable subtrees keep their relative positions when edits happen elsewhere. */
export function createNodeIndex(type: string): (node: Node) => readonly PositionedNode[] {
  const cache = new WeakMap<Node, readonly PositionedNode[]>();
  const empty: readonly PositionedNode[] = [];
  const read = (parent: Node): readonly PositionedNode[] => {
    const cached = cache.get(parent);
    if (cached) return cached;
    let found: PositionedNode[] | undefined;
    parent.forEach((node, pos) => {
      if (node.type.name === type) (found ??= []).push({ node, pos });
      if (node.isLeaf) return;
      for (const child of read(node))
        (found ??= []).push({ node: child.node, pos: pos + 1 + child.pos });
    });
    const result = found ?? empty;
    cache.set(parent, result);
    return result;
  };
  return read;
}
