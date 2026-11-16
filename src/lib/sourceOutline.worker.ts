import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Ast } from './editorPosition';

// Match the editor's grammar; its configured heading transforms run with the live schema.
const remark = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
self.onmessage = (event: MessageEvent<string>) => {
  const ast: Ast = remark.parse(event.data);
  const children: Ast[] = [];
  const walk = (node: Ast) => {
    if (node.type === 'heading' || node.type === 'definition') children.push(node);
    else node.children?.forEach(walk);
  };
  walk(ast);
  self.postMessage({ type: 'root', children });
};
