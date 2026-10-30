import { editorViewCtx } from '@milkdown/kit/core';
import { createEditor, getCurrentState } from '../../src/lib/editor';
import type { EditorUpdate } from '../../src/lib/types';

/** Run through Vite in a real browser; no mocked editor or React hooks. */
export async function runEditorSyncRegression(): Promise<string[]> {
  const root = document.createElement('div');
  document.body.append(root);
  const updates: EditorUpdate[] = [];
  const editor = createEditor(root, '', { onUpdate: (update) => updates.push(update) });
  await editor.create();
  try {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText('last character'));
    });
    const latest = getCurrentState(editor);
    if (updates[updates.length - 1]?.markdown !== latest.markdown) {
      throw new Error('F01: document change was not published before dispatch returned');
    }
    if (!latest.markdown.includes('last character')) throw new Error('Fixture did not edit the document');
    return ['document changes publish synchronously'];
  } finally {
    await editor.destroy();
    root.remove();
  }
}
