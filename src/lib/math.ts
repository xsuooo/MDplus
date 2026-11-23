/*!
Adapted from @milkdown/plugin-math 7.5.9.

The MIT License (MIT)

Copyright (c) 2020-present Mirone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { $ctx, $inputRule, $nodeSchema, $remark } from '@milkdown/kit/utils';
import { Fragment } from '@milkdown/kit/prose/model';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { nodeRule } from '@milkdown/kit/prose';
import { expectDomTypeError } from '@milkdown/kit/exception';
import katex, { type KatexOptions } from 'katex';
import remarkMath from 'remark-math';

export const remarkMathPlugin = $remark('remarkMath', () => remarkMath);
export const katexOptionsCtx = $ctx<KatexOptions, 'katexOptions'>({}, 'katexOptions');

export const mathInlineSchema = $nodeSchema('math_inline', (ctx) => ({
  group: 'inline',
  content: 'text*',
  inline: true,
  atom: true,
  parseDOM: [
    {
      tag: 'span[data-type="math_inline"]',
      getContent: (dom, schema) => {
        if (!(dom instanceof HTMLElement)) throw expectDomTypeError(dom);
        return Fragment.from(schema.text(dom.dataset.value ?? ''));
      },
    },
  ],
  toDOM: (node) => {
    const value = node.textContent;
    const dom = document.createElement('span');
    dom.dataset.type = 'math_inline';
    dom.dataset.value = value;
    katex.render(value, dom, ctx.get(katexOptionsCtx.key));
    return dom;
  },
  parseMarkdown: {
    match: (node) => node.type === 'inlineMath',
    runner: (state, node, type) => {
      state
        .openNode(type)
        .addText(node.value as string)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_inline',
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.textContent);
    },
  },
}));

export const mathInlineInputRule = $inputRule((ctx) =>
  nodeRule(/(?:\$)([^$]+)(?:\$)$/, mathInlineSchema.type(ctx), {
    beforeDispatch: ({ tr, match, start }) => {
      tr.insertText(match[1] ?? '', start + 1);
    },
  }),
);

export const mathBlockSchema = $nodeSchema('math_block', (ctx) => ({
  content: 'text*',
  group: 'block',
  marks: '',
  defining: true,
  atom: true,
  isolating: true,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-type="math_block"]',
      preserveWhitespace: 'full',
      getAttrs: (dom) => ({ value: dom.dataset.value ?? '' }),
    },
  ],
  toDOM: (node) => {
    const value = node.attrs.value;
    const dom = document.createElement('div');
    dom.dataset.type = 'math_block';
    dom.dataset.value = value;
    katex.render(value, dom, ctx.get(katexOptionsCtx.key));
    return dom;
  },
  parseMarkdown: {
    match: (node) => node.type === 'math',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_block',
    runner: (state, node) => {
      state.addNode('math', undefined, node.attrs.value);
    },
  },
}));

export const mathBlockInputRule = $inputRule(
  (ctx) =>
    new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
      const position = state.doc.resolve(start);
      return position
        .node(-1)
        .canReplaceWith(position.index(-1), position.indexAfter(-1), mathBlockSchema.type(ctx))
        ? state.tr.delete(start, end).setBlockType(start, start, mathBlockSchema.type(ctx))
        : null;
    }),
);

export const math = [
  remarkMathPlugin,
  katexOptionsCtx,
  mathInlineSchema,
  mathBlockSchema,
  mathBlockInputRule,
  mathInlineInputRule,
].flat();
