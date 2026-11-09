import type { Editor } from '@milkdown/kit/core';

export interface PendingEditorUpdate {
  timer: ReturnType<typeof setTimeout>;
  publish: () => void;
}

export const pendingEditorUpdates = new WeakMap<Editor, PendingEditorUpdate>();

/** Flush the latest document before a save, export, close or mode switch. */
export function flushEditorUpdate(editor: Editor): void {
  const pending = pendingEditorUpdates.get(editor);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingEditorUpdates.delete(editor);
  pending.publish();
}
