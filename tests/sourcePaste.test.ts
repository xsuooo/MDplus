import { describe, expect, it, vi } from 'vitest';
import { firstClipboardImage, pasteSourceImage } from '../src/lib/sourcePaste';

const image = new File(['image'], 'pic.png', { type: 'image/png' });

function clipboard(...items: { type: string; file?: File | null }[]): DataTransfer {
  return { items: items.map(({ type, file }) => ({ type, getAsFile: () => file ?? null })) } as unknown as DataTransfer;
}

function input(value = 'before selected after', start = 7, end = 15) {
  return {
    value, selectionStart: start, selectionEnd: end, isConnected: true,
    setSelectionRange: vi.fn(function (this: { selectionStart: number; selectionEnd: number }, from: number, to: number) {
      this.selectionStart = from;
      this.selectionEnd = to;
    }),
  };
}

function paste(clipboardData = clipboard({ type: 'image/png', file: image })) {
  return { clipboardData, preventDefault: vi.fn() };
}

describe('clipboard images', () => {
  it('returns the first image in a mixed clipboard', () => {
    const second = new File(['second'], 'second.jpg', { type: 'image/jpeg' });
    expect(firstClipboardImage(clipboard(
      { type: 'text/plain' }, { type: 'image/png', file: image }, { type: 'image/jpeg', file: second },
    ))).toBe(image);
  });

  it('skips unavailable image items', () => {
    expect(firstClipboardImage(clipboard({ type: 'image/png' }, { type: 'image/png', file: image }))).toBe(image);
  });

  it('returns null for text or absent clipboard data', () => {
    expect(firstClipboardImage(clipboard({ type: 'text/plain' }))).toBeNull();
    expect(firstClipboardImage(null)).toBeNull();
  });
});

describe('source image paste', () => {
  it.each(['image-only', 'mixed'])('intercepts %s, replaces the selection and restores the caret', async (kind) => {
    const field = input();
    const event = paste(kind === 'mixed'
      ? clipboard({ type: 'text/plain' }, { type: 'image/png', file: image }) : undefined);
    const save = vi.fn().mockResolvedValue('mdplus-image:abc');
    const change = vi.fn();
    await pasteSourceImage(event, field, save, change, () => true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(image);
    expect(change).toHaveBeenCalledWith('before ![](mdplus-image:abc) after');
    expect(field.value).toBe('before ![](mdplus-image:abc) after');
    expect(field.setSelectionRange).toHaveBeenCalledWith(28, 28);
  });

  it('inserts at a collapsed selection', async () => {
    const field = input('before after', 7, 7);
    await pasteSourceImage(paste(), field, async () => 'mdplus-image:abc', vi.fn(), () => true);
    expect(field.value).toBe('before ![](mdplus-image:abc)after');
    expect(field.selectionStart).toBe(28);
  });

  it('lets ordinary text use the native paste behavior', async () => {
    const event = paste(clipboard({ type: 'text/plain' }));
    const save = vi.fn();
    const change = vi.fn();
    await pasteSourceImage(event, input(), save, change, () => true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });

  it.each(['typing', 'selection', 'unmount', 'tab-switch', 'edit-and-revert'])(
    'does not overwrite after %s while the image is pending', async (changeKind) => {
      const field = input();
      const change = vi.fn();
      let current = true;
      let finish!: (url: string) => void;
      const work = pasteSourceImage(paste(), field, () => new Promise<string>((resolve) => { finish = resolve; }), change, () => current);
      if (changeKind === 'typing') field.value = 'new text';
      if (changeKind === 'selection') field.selectionStart = 0;
      if (changeKind === 'unmount') field.isConnected = false;
      if (changeKind === 'tab-switch' || changeKind === 'edit-and-revert') current = false;
      finish('mdplus-image:abc');
      await work;
      expect(change).not.toHaveBeenCalled();
      expect(field.setSelectionRange).not.toHaveBeenCalled();
      expect(field.value).toBe(changeKind === 'typing' ? 'new text' : 'before selected after');
    },
  );

  it('leaves text and selection unchanged on failure, without reporting another dialog', async () => {
    const field = input();
    const change = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await pasteSourceImage(paste(), field, async () => { throw new Error('save failed'); }, change, () => true);
      expect(change).not.toHaveBeenCalled();
      expect(field.value).toBe('before selected after');
      expect(field.setSelectionRange).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('does not insert an empty image reference', async () => {
    const change = vi.fn();
    await pasteSourceImage(paste(), input(), async () => '', change, () => true);
    expect(change).not.toHaveBeenCalled();
  });
});
