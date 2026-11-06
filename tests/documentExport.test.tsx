// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Editor } from '@milkdown/kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentSession } from '../src/hooks/useDocumentSession';
import { useDocumentExport } from '../src/hooks/useDocumentExport';
import type { RecoveryController } from '../src/hooks/useRecovery';
import type { Tab } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  captureExport: vi.fn(),
  captureImages: vi.fn(),
  readImage: vi.fn(),
  releaseImages: vi.fn(),
  html: vi.fn(),
  pdf: vi.fn(),
  prepare: vi.fn(),
  message: vi.fn(),
  clear: vi.fn(),
  parsedToken: 'mdplus-image:original',
}));
vi.mock('../src/lib/editor', () => ({ setMarkdown: vi.fn() }));
vi.mock('../src/lib/dialog', () => ({ showMessage: mocks.message }));
vi.mock('../src/lib/imageOps', () => ({
  capturePendingImages: mocks.captureImages,
  clearPendingImages: mocks.clear,
}));
vi.mock('../src/lib/export', () => ({
  assertExportBytes: vi.fn(),
  captureExport: mocks.captureExport,
  exportHTML: mocks.html,
  exportPDF: mocks.pdf,
}));
const initial = (): Tab => ({
  id: 'tab',
  title: 'original.md',
  path: 'C:/notes/original.md',
  isNew: false,
  dirty: false,
  markdown: 'original ![](./image.png)',
  savedContent: 'original ![](./image.png)',
  initialContent: 'original ![](./image.png)',
  diskRevision: 'A',
  externalMtime: 1,
  externalChanged: false,
  stats: { chars: 8, words: 1, lines: 1 },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function setup() {
  return renderHook(() => {
    const session = useDocumentSession([initial()]);
    if (session.tabsRef.current.length && !session.editorRegistry.current.tab)
      session.editorRegistry.current.tab = {} as Editor;
    const recovery = { prepareCurrentImages: mocks.prepare } as unknown as RecoveryController;
    const exporting = useDocumentExport(session, recovery, 'misans', 'jetbrains-sarasa');
    return { session, exporting };
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.parsedToken = 'mdplus-image:original';
  mocks.prepare.mockResolvedValue(true);
  mocks.message.mockResolvedValue(undefined);
  mocks.html.mockResolvedValue(true);
  mocks.pdf.mockResolvedValue(undefined);
  mocks.captureExport.mockImplementation(
    (_editor, markdown, title, bodyFont, codeFont, resolve) => {
      const content = document.createElement('div');
      const text = document.createElement('p');
      text.textContent = markdown;
      const image = document.createElement('img');
      image.src = resolve(mocks.parsedToken);
      content.append(text, image);
      return { title, content, bodyFont, codeFont };
    },
  );
  mocks.readImage.mockImplementation(async (_token, consume) => consume('AAEC'));
  mocks.captureImages.mockImplementation(() => ({
    images: [
      {
        placeholder: 'mdplus-image:original',
        filename: 'image.png',
        mime: 'image/png',
        byteLength: 3,
        relativePath: './image.png',
        source: { url: './image.png', absolutePath: 'C:/notes/image.png' },
      },
    ],
    withDataBase64: mocks.readImage,
    release: mocks.releaseImages,
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('export snapshots with leased native images', () => {
  it.each(['edit', 'close'])(
    'freezes the parser and image identity before a delayed hydration followed by %s',
    async (change) => {
      const gate = deferred();
      mocks.readImage.mockImplementation(async (_token, consume) => {
        await gate.promise;
        return consume('AAEC');
      });
      const hook = setup();
      let exporting!: Promise<void>;
      await act(async () => {
        exporting = hook.result.current.exporting.handleExportHTML();
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(mocks.captureExport).toHaveBeenCalledTimes(1);
      expect(mocks.readImage).toHaveBeenCalledTimes(1);
      expect(mocks.captureExport.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.readImage.mock.invocationCallOrder[0],
      );
      expect(mocks.html).not.toHaveBeenCalled();
      mocks.parsedToken = 'mdplus-image:later';
      act(() => {
        if (change === 'close') hook.result.current.session.removeTab('tab');
        else {
          hook.result.current.session.updateTab('tab', {
            path: 'D:/elsewhere/later.md',
            markdown: 'later document',
            diskRevision: 'B',
            dirty: true,
          });
          hook.result.current.session.contentGenerations.current.tab = 1;
        }
      });
      await act(async () => {
        gate.resolve();
        await exporting;
      });
      expect(mocks.html).toHaveBeenCalledTimes(1);
      const snapshot = mocks.html.mock.calls[0][0];
      expect(snapshot.title).toBe('original.md');
      expect(snapshot.content.textContent).toContain('original');
      expect(snapshot.content.textContent).not.toContain('later document');
      expect(snapshot.content.querySelector('img').getAttribute('src')).toBe(
        'data:image/png;base64,AAEC',
      );
      expect(mocks.releaseImages).toHaveBeenCalledTimes(1);
      expect(hook.result.current.exporting.exporting).toBe(false);
    },
  );

  it('uses the same self-contained bytes for PDF without leaking a preview URL', async () => {
    const hook = setup();
    await act(() => hook.result.current.exporting.handleExportPDF());
    const snapshot = mocks.pdf.mock.calls[0][0];
    expect(snapshot.content.querySelector('img').src).toBe('data:image/png;base64,AAEC');
    expect(mocks.html).not.toHaveBeenCalled();
    expect(mocks.releaseImages).toHaveBeenCalledTimes(1);
  });

  it('releases the lease and resets the busy state after a failed image read', async () => {
    mocks.readImage.mockRejectedValueOnce(new Error('stash read failed'));
    const hook = setup();
    await act(() => hook.result.current.exporting.handleExportHTML());
    expect(mocks.html).not.toHaveBeenCalled();
    expect(mocks.releaseImages).toHaveBeenCalledTimes(1);
    expect(mocks.message).toHaveBeenCalledWith(
      expect.stringContaining('stash read failed'),
      'error',
    );
    expect(hook.result.current.exporting.exporting).toBe(false);
    await act(() => hook.result.current.exporting.handleExportHTML());
    expect(mocks.html).toHaveBeenCalledTimes(1);
  });

  it('does not start a duplicate export while its image transfer is pending', async () => {
    const gate = deferred();
    mocks.readImage.mockImplementation(async (_token, consume) => {
      await gate.promise;
      return consume('AAEC');
    });
    const hook = setup();
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = hook.result.current.exporting.handleExportHTML();
      second = hook.result.current.exporting.handleExportHTML();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(mocks.captureImages).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve();
      await Promise.all([first, second]);
    });
    expect(mocks.html).toHaveBeenCalledTimes(1);
    expect(mocks.releaseImages).toHaveBeenCalledTimes(1);
  });
});
