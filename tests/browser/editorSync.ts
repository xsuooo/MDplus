import { editorStateCtx, editorViewCtx } from '@milkdown/kit/core';
import {
  createEditor,
  getCurrentState,
  getEditorImageReferences,
  setMarkdown,
  undo,
  redo,
} from '../../src/lib/editor';
import { DOMParser, DOMSerializer } from '@milkdown/prose/model';
import { undoDepth, redoDepth } from '@milkdown/prose/history';
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
    if (!latest.markdown.includes('last character'))
      throw new Error('Fixture did not edit the document');
    return ['document changes publish synchronously', ...(await runImageHistoryRegression())];
  } finally {
    await editor.destroy();
    root.remove();
  }
}

/** Real PM history: no private branch rewriting and no history reset on SaveAs. */
export async function runImageHistoryRegression(): Promise<string[]> {
  const raw = './img/pic.png';
  const original = '![photo](./img/pic.png)';
  const oldToken = 'mdplus-image:old-image';
  const newToken = 'mdplus-image:new-image';
  const aliases = new Map([[raw, oldToken]]);
  const sources = new Map([[oldToken, raw]]);
  const subscribers = new Set<() => void>();
  const reference = (token: string) => {
    const source = sources.get(token);
    return source && aliases.get(source) === token ? source : token;
  };
  const root = document.createElement('div');
  document.body.append(root);
  const editor = createEditor(root, original, {
    onUpdate: () => {},
    resolveImageIdentity: (url) => aliases.get(url) ?? url,
    resolveImageReference: reference,
    resolveImageSource: () =>
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    subscribeImageSources: (listener) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  });
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`M2: ${message}`);
  };
  const currentSources = () =>
    editor.action((ctx) => {
      const result: string[] = [];
      ctx.get(editorViewCtx).state.doc.descendants((node) => {
        if (node.type.name === 'image') result.push(node.attrs.src);
      });
      return result;
    });
  const scanImageReferences = () =>
    editor.action((ctx) => {
      const beforeView = ctx.get(editorViewCtx).state;
      const beforeContext = ctx.get(editorStateCtx);
      const beforeUndo = undoDepth(beforeView);
      const beforeRedo = redoDepth(beforeView);
      check(beforeContext === beforeView, 'fixture context and view state diverged before scan');
      const references = getEditorImageReferences(editor);
      check(ctx.get(editorViewCtx).state === beforeView, 'reachability mutated view.state');
      check(
        ctx.get(editorStateCtx) === beforeContext,
        'reachability polluted editorStateCtx with a history shadow',
      );
      check(
        undoDepth(ctx.get(editorViewCtx).state) === beforeUndo,
        'reachability changed undo depth',
      );
      check(
        redoDepth(ctx.get(editorViewCtx).state) === beforeRedo,
        'reachability changed redo depth',
      );
      return references;
    });
  await editor.create();
  try {
    check(currentSources()[0] === oldToken, 'initial rich image did not acquire a stable identity');
    check(
      getCurrentState(editor).markdown.includes(raw),
      'initial source/dirty baseline leaked a token',
    );
    setMarkdown(editor, 'image removed');
    // SaveAs has references=[]: no current image is migrated. The old directory's
    // aliases are invalidated, but the PM undo step must still own oldToken.
    aliases.clear();
    for (const listener of subscribers) listener();
    setMarkdown(editor, 'image removed', false);
    const before = editor.action((ctx) => ctx.get(editorViewCtx).state);
    check(scanImageReferences().has(oldToken), 'deleted image was absent from undo reachability');
    check(
      editor.action((ctx) => ctx.get(editorViewCtx).state) === before,
      'reachability mutated editor state',
    );
    check(undoDepth(before) > 0 && redoDepth(before) === 0, 'SaveAs reset history');
    undo(editor);
    check(currentSources()[0] === oldToken, 'Undo rebound the old raw URL to the new directory');
    check(
      getCurrentState(editor).markdown.includes(oldToken),
      'retired source URL was exposed as safe',
    );
    redo(editor);
    check(currentSources().length === 0, 'Redo lost the original deletion');
    check(scanImageReferences().has(oldToken), 'redo branch lost the image stash root');
    undo(editor);
    aliases.set(raw, newToken);
    sources.set(newToken, raw);
    setMarkdown(editor, original);
    check(currentSources()[0] === newToken, 'new raw source did not receive a separate identity');
    undo(editor);
    check(
      currentSources()[0] === oldToken,
      'same-named new image replaced bytes in old undo history',
    );
    check(scanImageReferences().has(newToken), 'redo-only image was absent from reachability');
    redo(editor);
    check(currentSources()[0] === newToken, 'Redo did not restore the new image identity');
    const reachable = scanImageReferences();
    check(
      reachable.has(oldToken) && reachable.has(newToken),
      'both immutable histories were not rooted',
    );
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const copied = document.createElement('div');
      copied.append(
        DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.doc.content),
      );
      check(
        copied.querySelector('img')?.getAttribute('src') === raw,
        'clipboard HTML leaked a transient preview URL or internal token',
      );
      check(
        DOMParser.fromSchema(view.state.schema).parse(copied).eq(view.state.doc),
        'clipboard image DOM did not rebind safely to its stable identity',
      );
    });
    return ['rich deleted image survives empty SaveAs/Undo/Redo and same-URL replacement'];
  } finally {
    await editor.destroy();
    root.remove();
  }
}
