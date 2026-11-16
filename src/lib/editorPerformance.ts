import { editorStateOptionsCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import type { Node } from '@milkdown/prose/model';
import { Plugin, PluginKey, type Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { refractor } from 'refractor';
import type { RootContent, Text } from 'hast';
import { createNodeIndex } from './documentNodes';

/** Keep GFM header alignment without resolving every cell in unchanged tables. */
export function createTableAlignmentPlugin(): Plugin {
  const checked = new WeakSet<Node>();
  const rows = new WeakMap<Node, readonly unknown[]>();
  return new Plugin({
    key: new PluginKey('mdplus-table-alignment'),
    appendTransaction: (_transactions, oldState, state) => {
      if (oldState.doc === state.doc) return null;
      let tr: Transaction | undefined;
      const inspect = (node: Node, pos: number): boolean => {
        if (checked.has(node)) return true;
        let valid = true;
        if (node.type.name === 'table') {
          const alignment: unknown[] = [];
          node.firstChild?.forEach((cell) => alignment.push(cell.attrs.alignment));
          node.forEach((row, rowOffset, rowIndex) => {
            if (rowIndex === 0) return;
            const previous = rows.get(row);
            if (
              previous?.length === alignment.length &&
              previous.every((value, index) => value === alignment[index])
            )
              return;
            let rowValid = true;
            row.forEach((cell, cellOffset, column) => {
              if (
                cell.type.name !== 'table_cell' ||
                column >= alignment.length ||
                cell.attrs.alignment === alignment[column]
              )
                return;
              tr ??= state.tr;
              tr.setNodeMarkup(pos + 2 + rowOffset + cellOffset, undefined, {
                ...cell.attrs,
                alignment: alignment[column],
              });
              rowValid = false;
            });
            if (rowValid) rows.set(row, alignment);
            else valid = false;
          });
        } else {
          node.forEach((child, offset) => {
            if (!child.isLeaf && !inspect(child, pos + 1 + offset)) valid = false;
          });
        }
        if (valid) checked.add(node);
        return valid;
      };
      inspect(state.doc, -1);
      return tr ?? null;
    },
  });
}

interface PrismToken {
  from: number;
  to: number;
  className: string[];
}

function flatPrismNodes(
  nodes: RootContent[],
  className: string[] = [],
): {
  text: string;
  className: string[];
}[] {
  return nodes.flatMap((node) =>
    node.type === 'element'
      ? flatPrismNodes(node.children, [
          ...className,
          ...((node.properties?.className as string[] | undefined) ?? []),
        ])
      : [{ text: (node as Text).value, className }],
  );
}

function prismTokens(
  cache: WeakMap<Node, readonly PrismToken[]>,
  node: Node,
  languages: string[],
  previous: DecorationSet,
  previousPos?: number,
): readonly PrismToken[] {
  const cached = cache.get(node);
  if (cached) return cached;
  if (previousPos !== undefined) {
    const from = previousPos + 1;
    const to = previousPos + node.nodeSize - 1;
    const inherited = previous.find(from, to).flatMap((decoration) => {
      if (decoration.from < from || decoration.to > to) return [];
      const attrs = (decoration as unknown as { type: { attrs: Record<string, unknown> } }).type
        .attrs;
      const className = String(attrs.class ?? '')
        .split(' ')
        .filter(Boolean);
      return [{ from: decoration.from - previousPos, to: decoration.to - previousPos, className }];
    });
    cache.set(node, inherited);
    return inherited;
  }
  const language = String(node.attrs.language ?? '');
  let tokens: readonly PrismToken[] = [];
  if (!language || !languages.includes(language)) {
    console.warn(
      'Unsupported language detected, this language has not been supported by current prism config: ',
      language,
    );
  } else {
    let from = 1;
    tokens = flatPrismNodes(refractor.highlight(node.textContent, language).children).flatMap(
      (token) => {
        const current = { from, to: from + token.text.length, className: token.className };
        from = current.to;
        return token.className.length ? [current] : [];
      },
    );
  }
  cache.set(node, tokens);
  return tokens;
}

/** Preserve Prism's renderer while bypassing its two full-tree scans for unrelated transactions. */
export function configurePrismTransactions(ctx: Ctx): void {
  ctx.update(editorStateOptionsCtx, (override) => (input) => {
    const options = override(input);
    return {
      ...options,
      plugins: options.plugins?.map((plugin) => {
        // shortcut: Milkdown 7.21 identifies Prism by this key, recheck when upgrading that plugin.
        if (!(plugin as Plugin & { key: string }).key.startsWith('MILKDOWN_PRISM$')) return plugin;
        const original = (plugin as Plugin<DecorationSet>).spec.state!;
        const codeBlocks = createNodeIndex('code_block');
        const tokenCache = new WeakMap<Node, readonly PrismToken[]>();
        return new Plugin<DecorationSet>({
          ...plugin.spec,
          state: {
            ...original,
            apply(transaction, previous, oldState, state) {
              if (!transaction.docChanged) return previous;
              const before = codeBlocks(oldState.doc);
              const after = codeBlocks(state.doc);
              if (
                before.length === after.length &&
                before.every((entry, index) => {
                  if (entry.node !== after[index].node) return false;
                  const start = transaction.mapping.mapResult(entry.pos, 1);
                  const end = transaction.mapping.mapResult(entry.pos + entry.node.nodeSize, -1);
                  return (
                    !start.deleted &&
                    !end.deleted &&
                    start.pos === after[index].pos &&
                    end.pos === after[index].pos + entry.node.nodeSize
                  );
                })
              )
                return previous.map(transaction.mapping, transaction.doc);

              const languages = refractor.listLanguages();
              const decorations: Decoration[] = [];
              const previousPositions = new Map(before.map((entry) => [entry.node, entry.pos]));
              for (const { node, pos } of after) {
                const tokens = prismTokens(
                  tokenCache,
                  node,
                  languages,
                  previous,
                  previousPositions.get(node),
                );
                for (const token of tokens) {
                  decorations.push(
                    Decoration.inline(pos + token.from, pos + token.to, {
                      class: token.className.join(' '),
                    }),
                  );
                }
              }
              return DecorationSet.create(state.doc, decorations);
            },
          },
        });
      }),
    };
  });
}
