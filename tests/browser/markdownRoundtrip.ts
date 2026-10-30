import { editorViewCtx } from '@milkdown/kit/core';
import { DOMParser, DOMSerializer } from '@milkdown/prose/model';
import { closeHistory } from '@milkdown/prose/history';
import { createEditor, getCurrentState, setMarkdown, undo } from '../../src/lib/editor';
import { getImageUrls } from '../../src/lib/imagePaths';

export const markdownCases = ['markdown-images', 'markdown-lists'] as const;
export type MarkdownCase = typeof markdownCases[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function runMarkdownRoundtrip(testCase: MarkdownCase): Promise<string> {
  const root = document.createElement('div');
  document.body.append(root);
  const images = [
    '![](mdplus-image:clipboard-1)',
    '![](./assets/image.png)',
    '![alt text](./assets/image.png)',
    '![titled](./assets/image.png "caption")',
    '![reference][pic]\n\n[pic]: ./assets/reference.png',
  ];
  const lists = [
    '- first\n- second',
    '3. first\n4. second',
    '- [x] first\n- [ ] second',
    '- first\n\n- second',
    '- first\n  - second',
    '3. first\n\n4. second',
    '- [x] first\n\n- [ ] second',
  ];
  const samples = testCase === 'markdown-images' ? images : lists;
  const editor = createEditor(root, samples[0], { onUpdate: () => {} });
  await editor.create();
  try {
    for (const [index, markdown] of samples.entries()) {
      if (index > 0) setMarkdown(editor, markdown);
      const first = getCurrentState(editor).markdown;
      if (testCase === 'markdown-images') {
        check(JSON.stringify(getImageUrls(first)) === JSON.stringify(getImageUrls(markdown)),
          `Image lost during Markdown parsing: ${markdown} => ${first}`);
      } else {
        check(first.includes('first') && first.includes('second'), `List lost: ${markdown} => ${first}`);
        check(first.includes('\n\n') === markdown.includes('\n\n'), `List spacing changed: ${markdown} => ${first}`);
        if (markdown.startsWith('3.')) check(first.startsWith('3.'), 'Ordered list start was lost');
        if (markdown.includes('[x]')) check(first.includes('[x]') && first.includes('[ ]'), 'Task state was lost');
      }
      setMarkdown(editor, first);
      check(getCurrentState(editor).markdown === first, 'A second mode switch changed the document');
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const dom = document.createElement('div');
        dom.append(DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.doc.content));
        const parsed = DOMParser.fromSchema(view.state.schema).parse(dom);
        parsed.check();
        check(parsed.eq(view.state.doc), 'Rendered DOM did not round-trip through its schema');
      });
      if (markdown.includes('[x]')) {
        const checkbox = root.querySelector<HTMLInputElement>('.md-task-checkbox')!;
        const paragraph = checkbox.parentElement!.querySelector('p')!;
        const lineHeight = parseFloat(getComputedStyle(paragraph).lineHeight);
        const box = checkbox.getBoundingClientRect();
        check(Math.abs(box.y + box.height / 2 - paragraph.getBoundingClientRect().y - lineHeight / 2) < 2,
          'Task checkbox is not aligned with its text');
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          view.dispatch(closeHistory(view.state.tr));
        });
        checkbox.click();
        check(!getCurrentState(editor).markdown.includes('[x]'), 'Task checkbox did not update the document');
        undo(editor);
        check(getCurrentState(editor).markdown === first, 'Undo did not restore task state');
      }
    }
    return `${testCase}: ${samples.length} real parser/serializer/DOM round trips passed`;
  } finally {
    await editor.destroy();
    root.remove();
  }
}
