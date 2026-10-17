type ImagePasteEvent = Pick<ClipboardEvent, 'clipboardData' | 'preventDefault'>;
type SourceInput = Pick<HTMLTextAreaElement, 'value' | 'selectionStart' | 'selectionEnd' | 'isConnected' | 'setSelectionRange'>;

export function firstClipboardImage(clipboard: DataTransfer | null): File | null {
  const items = clipboard?.items;
  if (!items) return null;
  for (let i = 0; i < items.length; i += 1) {
    if (!items[i].type.startsWith('image/')) continue;
    const file = items[i].getAsFile();
    if (file) return file;
  }
  return null;
}

export async function pasteSourceImage(
  event: ImagePasteEvent,
  input: SourceInput,
  save: (file: File) => Promise<string>,
  onChange: (text: string) => void,
  isCurrent: () => boolean,
): Promise<void> {
  const file = firstClipboardImage(event.clipboardData);
  if (!file) return;
  event.preventDefault();
  const { value, selectionStart, selectionEnd } = input;
  try {
    const url = await save(file);
    if (!url || !isCurrent() || !input.isConnected || input.value !== value
      || input.selectionStart !== selectionStart || input.selectionEnd !== selectionEnd) return;
    const reference = `![](${url})`;
    const text = value.slice(0, selectionStart) + reference + value.slice(selectionEnd);
    input.value = text;
    onChange(text);
    const caret = selectionStart + reference.length;
    input.setSelectionRange(caret, caret);
  } catch (error) {
    // App reports the save error; leave the text and selection untouched.
    console.error('粘贴图片失败', error);
  }
}
