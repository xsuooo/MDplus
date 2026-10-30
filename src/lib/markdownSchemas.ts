import type { Ctx } from '@milkdown/kit/ctx';
import { bulletListSchema, imageSchema, orderedListSchema } from '@milkdown/kit/preset/commonmark';
import { extendListItemSchemaForTask as listItemSchema } from '@milkdown/kit/preset/gfm';

/** Normalize Markdown/DOM attributes to the strict Milkdown schema types. */
export function configureMarkdownSchemas(ctx: Ctx): void {
  ctx.update(imageSchema.key, (original) => (ctx) => {
    const schema = original(ctx);
    return {
      ...schema,
      parseDOM: [{
        tag: 'img[src]',
        getAttrs: (dom) => ({
          src: dom.getAttribute('src') ?? '',
          alt: dom.getAttribute('alt') ?? '',
          title: dom.getAttribute('title') ?? '',
        }),
      }],
      parseMarkdown: {
        ...schema.parseMarkdown,
        runner: (state, node, type) => {
          // Remark uses null for an absent title; Milkdown 7.21.3 requires a string.
          schema.parseMarkdown.runner(state, { ...node, alt: node.alt ?? '', title: node.title ?? '' }, type);
        },
      },
    };
  });

  // The bundled list parsers stringify spread although their schemas require booleans.
  for (const listSchema of [bulletListSchema, orderedListSchema, listItemSchema]) {
    ctx.update(listSchema.key, (original) => (ctx) => {
      const schema = original(ctx);
      return {
        ...schema,
        parseDOM: schema.parseDOM?.map((rule) => {
          if (!('tag' in rule) || !rule.getAttrs) return rule;
          const getAttrs = rule.getAttrs;
          return {
            ...rule,
            getAttrs: (dom: HTMLElement) => {
              const attrs = getAttrs(dom);
              if (!attrs) return attrs;
              return {
                ...attrs,
                ...(listSchema === listItemSchema ? {
                  label: attrs.label ?? '\u2022',
                  listType: attrs.listType ?? 'bullet',
                } : {}),
                spread: attrs.spread === true || attrs.spread === 'true',
              };
            },
          };
        }),
        parseMarkdown: {
          ...schema.parseMarkdown,
          runner: (state, node, type) => {
            const spread = node.spread === true;
            if (listSchema === listItemSchema) {
              state.openNode(type, {
                label: node.label != null ? `${node.label}.` : '\u2022',
                listType: node.label != null ? 'ordered' : 'bullet',
                spread,
                checked: node.checked ?? null,
              });
            } else {
              state.openNode(type, { spread, ...(node.ordered ? { order: node.start ?? 1 } : {}) });
            }
            state.next(node.children).closeNode();
          },
        },
        toMarkdown: {
          ...schema.toMarkdown,
          runner: (state, node) => {
            if (listSchema === listItemSchema) {
              state.openNode('listItem', undefined, {
                spread: node.attrs.spread,
                ...(node.attrs.checked != null ? { checked: node.attrs.checked } : {}),
              });
            } else {
              const ordered = listSchema === orderedListSchema;
              state.openNode('list', undefined, {
                ordered,
                spread: node.attrs.spread,
                ...(ordered ? { start: node.attrs.order } : {}),
              });
            }
            state.next(node.content).closeNode();
          },
        },
      };
    });
  }
}
