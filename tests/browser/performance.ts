import { editorViewCtx } from '@milkdown/kit/core';
import { closeHistory, undoDepth } from '@milkdown/prose/history';
import { TextSelection } from '@milkdown/prose/state';
import { createEditor, getCurrentState, undo } from '../../src/lib/editor';
import type { EditorUpdate } from '../../src/lib/types';
import '../../src/styles/global.css';

export const performanceCases = ['performance-large-table'] as const;
export type PerformanceCase = (typeof performanceCases)[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: samples.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    maxMs: sorted[sorted.length - 1],
  };
}

/** Timings are evidence, not machine-dependent gates; content and history remain assertions. */
export async function runPerformanceRegression(testCase: PerformanceCase): Promise<string> {
  const rows = 1200;
  const markdown = [
    '# Large table regression',
    'Before table marker.',
    '| Name | Number | Notes | Code | Status |\n| :--- | ---: | :---: | --- | --- |\n' +
      Array.from(
        { length: rows },
        (_, index) =>
          `| Row ${index} | ${index} | 中文 cell-${index} | \`value_${index}\` | Ready |`,
      ).join('\n'),
    'After table marker.',
    '```typescript\nconst answer = 42;\n```',
  ].join('\n\n');
  const host = document.createElement('div');
  host.className = 'milkdown-container';
  host.style.cssText = 'width:960px;height:620px;overflow:auto;position:relative';
  document.body.append(host);
  let latest: EditorUpdate | undefined;
  let updates = 0;
  const editor = createEditor(host, markdown, {
    onUpdate: (update) => {
      latest = update;
      updates++;
    },
    resolveImageIdentity: (url) => url,
    resolveImageReference: (url) => url,
  });
  await editor.create();
  try {
    await document.fonts.ready;
    await frame();
    await frame();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    const originalDoc = view.state.doc;
    const originalMarkdown = getCurrentState(editor).markdown;
    const position = (text: string) => {
      let found: number | undefined;
      view.state.doc.descendants((node, at) => {
        if (node.isText && node.text?.includes(text)) found ??= at;
      });
      check(found !== undefined, `Missing table fixture text: ${text}`);
      return found;
    };
    const input: Record<string, ReturnType<typeof distribution>> = {};
    for (const [name, text] of [
      ['beforeTable', 'Before table marker.'],
      ['insideTable', 'cell-600'],
      ['afterTable', 'After table marker.'],
    ]) {
      let caret = position(text);
      const costs: number[] = [];
      for (let index = 0; index < 10; index++) {
        const inserted = `${name}${index} `;
        const transaction = view.state.tr.insertText(inserted, caret);
        if (index === 0) closeHistory(transaction);
        const start = performance.now();
        view.dispatch(transaction);
        costs.push(performance.now() - start);
        caret += inserted.length;
        check(latest?.markdown.includes(inserted), 'Input returned before its content mirror');
        await frame();
      }
      input[name] = distribution(costs);
    }
    const selectionCosts: number[] = [];
    const editedDoc = view.state.doc;
    const updatesBeforeSelection = updates;
    const selectionStart = position('cell-600');
    for (let index = 0; index < 20; index++) {
      const transaction = view.state.tr.setSelection(
        TextSelection.create(view.state.doc, selectionStart + (index % 4)),
      );
      const start = performance.now();
      view.dispatch(transaction);
      selectionCosts.push(performance.now() - start);
    }
    check(view.state.doc === editedDoc, 'Selection rebuilt the table document');
    check(updates === updatesBeforeSelection, 'Selection republished document content');
    check(host.querySelectorAll('tbody tr').length === rows + 1, 'Table rows were lost');
    const maximum = host.scrollHeight - host.clientHeight;
    check(maximum > host.clientHeight, 'Large table must overflow its viewport');
    const scrollCosts: number[] = [];
    let previousFrame = await frame();
    for (let index = 1; index <= 24; index++) {
      host.scrollTop = (maximum * index) / 24;
      const now = await frame();
      scrollCosts.push(now - previousFrame);
      previousFrame = now;
    }
    check(host.scrollTop > maximum - 2, 'Large table could not scroll to its end');
    check(view.state.doc === editedDoc, 'Scrolling rebuilt document content');
    const undoSteps = undoDepth(view.state);
    check(undoSteps >= 3, 'Separate table input groups lost their undo boundaries');
    for (let index = 0; index < undoSteps; index++) undo(editor);
    check(view.state.doc.eq(originalDoc), 'Table input did not retain its undo boundaries');
    check(getCurrentState(editor).markdown === originalMarkdown, 'Undo changed table alignment');
    return JSON.stringify({
      case: testCase,
      rows,
      columns: 5,
      visibility: document.visibilityState,
      viewport: { width: innerWidth, height: innerHeight },
      utf8Bytes: new TextEncoder().encode(markdown).length,
      input,
      selection: distribution(selectionCosts),
      scrollFrames: distribution(scrollCosts),
      scope: 'Real Milkdown transactions and browser frames; no native IPC or hardware IME.',
    });
  } finally {
    await editor.destroy();
    host.remove();
  }
}
