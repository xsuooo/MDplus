// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { TextSelection } from '@milkdown/prose/state';
import { undoDepth } from '@milkdown/prose/history';
import {
  captureRenderedSessionPlace,
  captureSourceSessionPlace,
  renderedSessionPlace,
  restoreSessionRendered,
  restoreSessionSource,
  sourceSessionPlace,
} from '../src/lib/editorPosition';
import { useDocumentSession } from '../src/hooks/useDocumentSession';
import { useEditorView } from '../src/hooks/useEditorView';
import type { RecoveryController } from '../src/hooks/useRecovery';
import { computeStats } from '../src/lib/stats';
import type { Tab } from '../src/lib/types';
import { ImageSelection } from '../src/lib/imageSelection';

vi.mock('../src/lib/mermaid', () => ({ refreshMermaidTheme: vi.fn() }));
const editors: { editor: Editor; host: HTMLElement }[] = [];
const inputs: HTMLTextAreaElement[] = [];
let originalFonts: PropertyDescriptor | undefined;
afterEach(async () => {
  cleanup();
  for (const { editor, host } of editors.splice(0)) {
    await editor.destroy();
    host.remove();
  }
  for (const input of inputs.splice(0)) input.remove();
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
  originalFonts = undefined;
  vi.restoreAllMocks();
});
function input(markdown: string) {
  const field = document.createElement('textarea');
  field.value = markdown;
  document.body.append(field);
  inputs.push(field);
  return field;
}
async function fixture(markdown: string) {
  const host = document.createElement('div');
  host.className = 'milkdown-container';
  document.body.append(host);
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(history);
  await editor.create();
  editors.push({ editor, host });
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.setProps({ handleScrollToSelection: () => true });
  return { editor, view, host };
}
function initial(markdown: string): Tab {
  return {
    id: 'a',
    title: 'a.md',
    path: 'C:/a.md',
    isNew: false,
    dirty: false,
    markdown,
    savedContent: markdown,
    initialContent: markdown,
    stats: computeStats(markdown),
    externalMtime: 1,
    diskRevision: 'disk:a',
    externalChanged: false,
  };
}

describe('serialized editor positions', () => {
  it('restores a caret for disjoint image selections without selecting intervening text', async () => {
    const markdown =
      '# Images\n\n![left](left.png) Keep this text ![right](right.png)\n\n![last](last.png)\n';
    const original = await fixture(markdown);
    const positions: number[] = [];
    original.view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') positions.push(pos);
    });
    original.view.dispatch(
      original.view.state.tr.setSelection(
        ImageSelection.create(original.view.state.doc, [positions[0], positions[2]]),
      ),
    );
    const saved = JSON.parse(JSON.stringify(renderedSessionPlace(original.editor, markdown)));
    expect(saved.start).toEqual(saved.end);
    const latest = '# New preceding title\n\n' + markdown;
    const current = await fixture(latest);
    const documentBefore = current.view.state.doc;
    restoreSessionRendered(current.editor, latest, saved);
    expect(current.view.state.selection.empty).toBe(true);
    current.view.dispatch(current.view.state.tr.deleteSelection());
    expect(current.view.state.doc).toBe(documentBefore);
    expect(undoDepth(current.view.state)).toBe(0);
  });

  it('maps a backward rendered selection to latest disk text without changing document or undo history', async () => {
    const markdown = '# Original\n\nBody **selected target** text.\n';
    const original = await fixture(markdown);
    let target = 0;
    original.view.state.doc.descendants((node, at) => {
      if (node.isText && node.text?.includes('selected target'))
        target = at + node.text.indexOf('selected target');
    });
    original.view.dispatch(
      original.view.state.tr.setSelection(
        TextSelection.create(original.view.state.doc, target + 'selected target'.length, target),
      ),
    );
    const saved = JSON.parse(JSON.stringify(renderedSessionPlace(original.editor, markdown)));
    expect(saved.direction).toBe('backward');
    expect(saved).not.toHaveProperty('doc');
    expect(saved).not.toHaveProperty('selection');
    const latest = '# A new preceding title\n\nNew preceding paragraph.\n\n' + markdown;
    const current = await fixture(latest);
    const documentBefore = current.view.state.doc;
    restoreSessionRendered(current.editor, latest, saved);
    const selection = current.view.state.selection;
    expect(current.view.state.doc.textBetween(selection.from, selection.to)).toBe(
      'selected target',
    );
    expect(selection.anchor).toBeGreaterThan(selection.head);
    expect(current.view.state.doc).toBe(documentBefore);
    expect(undoDepth(current.view.state)).toBe(0);
  });

  it('restores live source selection/direction and falls back to pixels when layout measurement is unavailable', () => {
    const markdown = '# Source\n\nThe selected target stays on disk.\n';
    const field = input(markdown);
    const offset = markdown.indexOf('selected target');
    field.setSelectionRange(offset, offset + 15, 'backward');
    field.scrollTop = 245;
    const saved = sourceSessionPlace(field);
    field.value = 'A paragraph inserted on disk.\n\n' + markdown;
    restoreSessionSource(field, saved);
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe('selected target');
    expect(field.selectionDirection).toBe('backward');
    expect(field.scrollTop).toBe(245);
    expect(saved).not.toHaveProperty('markdown');
  });

  it('defers source mirror construction and freezes text, selection, scroll and wrapping metrics', () => {
    const markdown = 'prefix\nselected target\n' + 'Long wrapped text. '.repeat(100);
    const field = input(markdown);
    Object.defineProperty(field, 'clientWidth', { configurable: true, value: 480 });
    field.style.fontSize = '16px';
    field.style.lineHeight = '20px';
    field.setSelectionRange(7, 22, 'backward');
    field.scrollTop = 120;
    field.scrollLeft = 5;
    const createElement = vi.spyOn(document, 'createElement');
    const capture = captureSourceSessionPlace(field, markdown);
    expect(createElement).not.toHaveBeenCalled();

    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => {
        const mirror = range.startContainer.parentElement!;
        expect(mirror.style.width).toBe('480px');
        expect(mirror.style.fontSize).toBe('16px');
        return new DOMRect(0, Math.floor(range.startOffset / 40) * 20, 10, 20);
      };
      return range;
    });
    field.value = 'Background replacement';
    field.style.fontSize = '32px';
    field.scrollTop = 0;
    field.setSelectionRange(0, 0);
    Object.defineProperty(field, 'clientWidth', { configurable: true, value: 0 });
    field.remove();
    const saved = capture();
    expect(createElement).toHaveBeenCalledExactlyOnceWith('div');
    expect(saved).toMatchObject({
      sourceMode: true,
      start: { offset: 7 },
      end: { offset: 22 },
      direction: 'backward',
      top: 120,
      left: 5,
      scroll: { anchor: { offset: 240 }, gap: 0 },
    });
  });

  it('freezes the first visible table cell geometry without reading its DOM during persistence', async () => {
    const markdown = '| Left | Right |\n| --- | --- |\n| First | Second |\n| Third | Fourth |\n';
    const original = await fixture(markdown);
    original.host.scrollTop = 45;
    const paragraphs: { pos: number; row: number }[] = [];
    original.view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph')
        paragraphs.push({ pos, row: Math.floor(paragraphs.length / 2) });
    });
    const measurements = paragraphs.map(({ pos, row }) => {
      const node = original.view.nodeDOM(pos) as HTMLElement;
      return vi
        .spyOn(node, 'getBoundingClientRect')
        .mockImplementation(() => new DOMRect(0, row * 30 - original.host.scrollTop, 80, 30));
    });
    const capture = captureRenderedSessionPlace(original.editor, markdown);
    for (const measurement of measurements) {
      expect(measurement.mock.calls.length).toBeLessThanOrEqual(1);
      measurement.mockClear();
    }
    original.host.scrollTop = 0;
    original.view.dispatch(original.view.state.tr.insertText('changed ', paragraphs[2].pos + 1));
    const saved = capture();
    for (const measurement of measurements) expect(measurement).not.toHaveBeenCalled();
    expect(saved).toMatchObject({
      top: 45,
      scroll: {
        anchor: { offset: markdown.indexOf('| First') },
        gap: -15,
        fraction: 0.5,
      },
    });
  });

  it('applies restored source anchors after registration and preserves later user navigation during font settling', async () => {
    const markdown = '# Source\n\nThe selected target stays on disk.\n';
    const field = input(markdown);
    const offset = markdown.indexOf('selected target');
    field.setSelectionRange(offset, offset + 15, 'backward');
    const saved = sourceSessionPlace(field);
    field.setSelectionRange(0, 0);
    let resolveFonts!: () => void;
    originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: new Promise<void>((resolve) => {
          resolveFonts = resolve;
        }),
      },
    });
    const recovery = {
      prepareCurrentImages: vi.fn(async () => true),
      protectDraft: vi.fn(),
      cleanRecovery: vi.fn(async () => true),
    } as unknown as RecoveryController;
    const hook = renderHook(() => {
      const session = useDocumentSession([initial(markdown)]);
      useEditorView(session, recovery, vi.fn(), vi.fn(), false);
      return session;
    });
    await act(async () => {
      hook.result.current.registerSource('a', field);
      hook.result.current.installSessionPlace('a', saved);
    });
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe('selected target');
    expect(hook.result.current.positions.current.a.pendingSessionPlace).toBeUndefined();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    field.setSelectionRange(4, 4);
    await act(async () => {
      resolveFonts();
      await Promise.resolve();
    });
    expect(field.selectionStart).toBe(4);
    expect(field.selectionEnd).toBe(4);
    expect(recovery.protectDraft).not.toHaveBeenCalled();
  });
});
