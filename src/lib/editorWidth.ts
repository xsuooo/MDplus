export type EditorWidth = 'centered' | 'full';
export const EDITOR_WIDTH_STORAGE_KEY = 'mdplus-editor-width';

export const normalizeEditorWidth = (value: unknown): EditorWidth =>
  value === 'full' ? 'full' : 'centered';

export function readEditorWidth(storage?: Pick<Storage, 'getItem'>): EditorWidth {
  try {
    return normalizeEditorWidth((storage ?? window.localStorage).getItem(EDITOR_WIDTH_STORAGE_KEY));
  } catch {
    return 'centered';
  }
}

export function writeEditorWidth(width: EditorWidth, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? window.localStorage).setItem(EDITOR_WIDTH_STORAGE_KEY, normalizeEditorWidth(width));
  } catch {
    // Layout remains usable when preference storage is unavailable.
  }
}
