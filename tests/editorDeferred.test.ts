// @vitest-environment jsdom
import { editorViewCtx } from '@milkdown/kit/core';
import type { Editor } from '@milkdown/kit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditor } from '../src/lib/editor';
import { flushEditorUpdate } from '../src/lib/editorUpdates';
import type { EditorUpdate } from '../src/lib/types';

const editors: { editor: Editor; host: HTMLElement }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const { editor, host } of editors.splice(0)) {
    await editor.destroy();
    host.remove();
  }
});

describe('coalesced editor snapshots', () => {
  it('records every edit but serializes once per window or on demand', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const updates: EditorUpdate[] = [];
    const activities: Pick<EditorUpdate, 'canUndo' | 'canRedo'>[] = [];
    const editor = createEditor(host, 'start', {
      deferUpdates: true,
      onUpdate: (update) => updates.push(update),
      onActivity: (activity) => activities.push(activity),
    });
    editors.push({ editor, host });
    await editor.create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    vi.useFakeTimers();

    view.dispatch(view.state.tr.insertText('A', 1));
    view.dispatch(view.state.tr.insertText('B', 2));
    expect(activities).toHaveLength(2);
    expect(updates).toHaveLength(0);
    vi.advanceTimersByTime(119);
    expect(updates).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].markdown).toBe('ABstart\n');

    view.dispatch(view.state.tr.insertText('C', 3));
    expect(activities).toHaveLength(3);
    flushEditorUpdate(editor);
    expect(updates).toHaveLength(2);
    expect(updates[1].markdown).toBe('ABCstart\n');

    view.dispatch(view.state.tr.insertText('D', 4));
    await editor.destroy();
    vi.advanceTimersByTime(1000);
    expect(updates).toHaveLength(2);
  });
});
