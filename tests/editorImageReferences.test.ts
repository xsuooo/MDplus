// @vitest-environment jsdom
import { editorViewCtx, type Editor } from '@milkdown/kit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditor, getEditorImageReferences, redo, undo } from '../src/lib/editor';

const editors: { editor: Editor; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const { editor, host } of editors.splice(0)) {
    await editor.destroy();
    host.remove();
  }
});

describe('image reachability scheduling', () => {
  it('skips text-only edits but preserves history and discarded redo references', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const changed = vi.fn();
    const editor = createEditor(host, '![a](a.png)\n\n![b](b.png)', {
      onUpdate: () => {},
      onImageReferencesChanged: changed,
    });
    editors.push({ editor, host });
    await editor.create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    changed.mockClear();

    view.dispatch(view.state.tr.insertText('text', view.state.doc.content.size - 1));
    expect(changed).not.toHaveBeenCalled();
    expect([...getEditorImageReferences(editor)].sort()).toEqual(['a.png', 'b.png']);

    let imagePos = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image' && node.attrs.src === 'b.png') imagePos = pos;
    });
    view.dispatch(view.state.tr.delete(imagePos, imagePos + 1));
    expect(changed).toHaveBeenCalledTimes(1);
    expect([...getEditorImageReferences(editor)].sort()).toEqual(['a.png', 'b.png']);

    undo(editor);
    expect(changed).toHaveBeenCalledTimes(2);
    redo(editor);
    expect(changed).toHaveBeenCalledTimes(3);
    expect([...getEditorImageReferences(editor)].sort()).toEqual(['a.png', 'b.png']);

    view.dispatch(view.state.tr.insertText('x', view.state.doc.content.size - 1));
    expect(changed).toHaveBeenCalledTimes(3);
    expect([...getEditorImageReferences(editor)].sort()).toEqual(['a.png', 'b.png']);
  });

  it('drops references from a redo branch discarded by a new edit', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const changed = vi.fn();
    const editor = createEditor(host, '![a](a.png)', {
      onUpdate: () => {},
      onImageReferencesChanged: changed,
    });
    editors.push({ editor, host });
    await editor.create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    changed.mockClear();

    const image = view.state.schema.nodes.image.create({ src: 'b.png' });
    view.dispatch(view.state.tr.insert(view.state.doc.content.size - 1, image));
    expect(changed).toHaveBeenCalledTimes(1);
    undo(editor);
    expect(changed).toHaveBeenCalledTimes(2);
    expect([...getEditorImageReferences(editor)].sort()).toEqual(['a.png', 'b.png']);

    view.dispatch(view.state.tr.insertText('x', view.state.doc.content.size - 1));
    expect(changed).toHaveBeenCalledTimes(3);
    expect([...getEditorImageReferences(editor)]).toEqual(['a.png']);
  });
});
