// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  remarkCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { Transform } from '@milkdown/prose/transform';
import { undoDepth } from '@milkdown/prose/history';
import { TextSelection } from '@milkdown/prose/state';
import { useDocumentSession } from '../src/hooks/useDocumentSession';
import { useEditorView } from '../src/hooks/useEditorView';
import type { RecoveryController } from '../src/hooks/useRecovery';
import { getCurrentState, undo } from '../src/lib/editor';
import { configureMarkdownSchemas } from '../src/lib/markdownSchemas';
import { computeStats } from '../src/lib/stats';
import {
  extractSourceOutline,
  renderedPlace,
  renderedSessionPlace,
  sourcePlace,
} from '../src/lib/editorPosition';
import type { EditorUpdate, Tab } from '../src/lib/types';
import { TAB_RENDER_MS } from '../src/config/constants';

vi.mock('../src/lib/mermaid', () => ({ refreshMermaidTheme: vi.fn() }));
vi.mock('../src/lib/stats', async (original) => {
  const actual = await original<typeof import('../src/lib/stats')>();
  return { ...actual, computeStats: vi.fn(actual.computeStats) };
});
vi.mock('../src/lib/editorPosition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/editorPosition')>();
  // Source-to-rich position geometry has browser coverage; this fixture tracks
  // the real parser, serializer and PM state at the synchronization boundary.
  return { ...actual, toRendered: vi.fn() };
});

const editors: { editor: Editor; host: HTMLElement }[] = [];
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  for (const { editor, host } of editors.splice(0)) {
    await editor.destroy();
    host.remove();
  }
  document.querySelectorAll('textarea').forEach((input) => input.remove());
});

function initialTab(id: string, markdown: string): Tab {
  return {
    id,
    title: `${id}.md`,
    path: null,
    isNew: true,
    dirty: false,
    markdown,
    savedContent: markdown,
    initialContent: markdown,
    stats: computeStats(markdown),
    externalMtime: 0,
    diskRevision: null,
    externalChanged: false,
  };
}

async function createFixture(markdown: string, imageIdentity?: () => string) {
  const host = document.createElement('div');
  host.className = 'milkdown-container';
  document.body.append(host);
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, markdown);
    })
    .config(configureMarkdownSchemas)
    .use(commonmark)
    .use(gfm)
    .use(history);
  await editor.create();
  editors.push({ editor, host });
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.setProps({ handleScrollToSelection: () => true });
  const { parse, serialize } = editor.action((ctx) => {
    const parser = ctx.get(parserCtx);
    const serializer = ctx.get(serializerCtx);
    const parse = vi.fn((text: string) => {
      const parsed = parser(text);
      if (!parsed || !imageIdentity) return parsed;
      const transform = new Transform(parsed);
      parsed.descendants((node, pos) => {
        if (node.type.name === 'image')
          transform.setNodeMarkup(pos, undefined, { ...node.attrs, src: imageIdentity() });
      });
      return transform.doc;
    });
    const serialize = vi.fn(serializer);
    ctx.set(parserCtx, parse);
    ctx.set(serializerCtx, serialize);
    return { parse, serialize };
  });
  return { editor, view, host, parse, serialize };
}

function setup(tabs: Tab[]) {
  const recovery = {
    prepareCurrentImages: vi.fn(async () => true),
    protectDraft: vi.fn(),
    cleanRecovery: vi.fn(async () => true),
  } as unknown as RecoveryController;
  const hook = renderHook(() => {
    const session = useDocumentSession(tabs);
    const view = useEditorView(session, recovery, vi.fn(), vi.fn(), false);
    return { session, view };
  });
  return { ...hook, recovery };
}

describe('tab activation synchronization', () => {
  it('publishes source input immediately while coalescing the tab UI render', () => {
    vi.useFakeTimers();
    try {
      const hook = setup([initialTab('a', 'Original source.\n')]);
      const expectedStats = computeStats('Newest source.\n');
      vi.mocked(computeStats).mockClear();
      act(() => {
        hook.result.current.view.handleSourceChange('a', 'Latest source.\n');
        vi.advanceTimersByTime(TAB_RENDER_MS / 2);
        hook.result.current.view.handleSourceChange('a', 'Newest source.\n');
      });
      expect(hook.result.current.session.tabsRef.current[0].markdown).toBe('Newest source.\n');
      expect(hook.result.current.session.tabMirror.current.a.markdown).toBe('Newest source.\n');
      expect(hook.result.current.session.tabs[0].markdown).toBe('Original source.\n');
      expect(computeStats).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(TAB_RENDER_MS / 2));
      expect(hook.result.current.session.tabs[0].markdown).toBe('Newest source.\n');
      expect(hook.result.current.session.tabs[0].stats).toEqual(expectedStats);
      expect(computeStats).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('uses existing source for initial metadata without serializing again', async () => {
    const fixture = await createFixture('# Original\n');
    fixture.serialize.mockClear();

    const update = getCurrentState(fixture.editor, '# Original\n');

    expect(update.markdown).toBe('# Original\n');
    expect(update.stats).toEqual(computeStats('# Original\n'));
    expect(update.outline[0]?.text).toBe('Original');
    expect(fixture.serialize).not.toHaveBeenCalled();
  });

  it('extracts source headings with real Markdown syntax and offsets without changing the rich document', async () => {
    const markdown =
      '# 中文 😀 **加粗** [链接](./a.md) `code` ![alt](./a.png)\n\nSetext 标题\n---\n\n```md\n# 不是标题\n```\n\n## 重复\n\n## 重复\n';
    const fixture = await createFixture(markdown);
    const before = fixture.view.state.doc;
    const parse = (markdown: string) =>
      fixture.editor.action((ctx) => ctx.get(remarkCtx).parse(markdown));
    expect(extractSourceOutline(fixture.editor, markdown, parse(markdown))).toEqual([
      { level: 1, text: '中文 😀 加粗 链接 code ', pos: 0 },
      { level: 2, text: 'Setext 标题', pos: markdown.indexOf('Setext') },
      { level: 2, text: '重复', pos: markdown.indexOf('## 重复') },
      { level: 2, text: '重复', pos: markdown.lastIndexOf('## 重复') },
    ]);
    expect(extractSourceOutline(fixture.editor, '# 新标题\n', parse('# 新标题\n'))[0].text).toBe(
      '新标题',
    );
    expect(fixture.view.state.doc).toBe(before);
  });
  it('does not parse or serialize retained rich documents on cold or repeated tab activation', async () => {
    const first = await createFixture('# First\n\nFirst document.\n');
    const second = await createFixture('# Second\n\nSecond document.\n');
    const hook = setup([
      initialTab('a', '# First\n\nFirst document.\n'),
      initialTab('b', '# Second\n\nSecond document.\n'),
    ]);
    hook.result.current.session.editorRegistry.current = { a: first.editor, b: second.editor };
    const firstDoc = first.view.state.doc;
    const secondDoc = second.view.state.doc;
    const firstHeading = first.host.querySelector('h1');
    const secondHeading = second.host.querySelector('h1');
    const firstRemarkParse = vi.spyOn(
      first.editor.action((ctx) => ctx.get(remarkCtx)),
      'parse',
    );
    const secondRemarkParse = vi.spyOn(
      second.editor.action((ctx) => ctx.get(remarkCtx)),
      'parse',
    );
    first.host.scrollTop = 120;
    second.host.scrollTop = 240;

    act(() => hook.result.current.session.selectTab('b'));
    expect(second.parse).not.toHaveBeenCalled();
    expect(second.serialize).not.toHaveBeenCalled();
    expect(firstRemarkParse).not.toHaveBeenCalled();
    expect(secondRemarkParse).not.toHaveBeenCalled();
    for (const id of ['a', 'b', 'a', 'b', 'a'])
      act(() => hook.result.current.session.selectTab(id));

    expect(first.parse).not.toHaveBeenCalled();
    expect(first.serialize).not.toHaveBeenCalled();
    expect(second.parse).not.toHaveBeenCalled();
    expect(second.serialize).not.toHaveBeenCalled();
    expect(first.view.state.doc).toBe(firstDoc);
    expect(second.view.state.doc).toBe(secondDoc);
    expect(first.host.querySelector('h1')).toBe(firstHeading);
    expect(second.host.querySelector('h1')).toBe(secondHeading);
    expect(first.host.scrollTop).toBe(120);
    expect(second.host.scrollTop).toBe(240);
  });

  it('defers edited document anchors until persistence and keeps the departing document snapshot', async () => {
    const markdown = '# Original\n\nBody selected target text.\n';
    const first = await createFixture(markdown);
    const hook = setup([initialTab('a', markdown), initialTab('b', 'Other document.\n')]);
    hook.result.current.session.editorRegistry.current.a = first.editor;
    act(() => {
      first.view.dispatch(first.view.state.tr.insertText(' changed', 9));
      let selected = 0;
      first.view.state.doc.descendants((node, at) => {
        if (node.isText && node.text?.includes('selected target'))
          selected = at + node.text.indexOf('selected target');
      });
      first.view.dispatch(
        first.view.state.tr.setSelection(
          TextSelection.create(first.view.state.doc, selected + 15, selected),
        ),
      );
      hook.result.current.view.handleTabUpdate('a', getCurrentState(first.editor));
    });
    const departedMarkdown = hook.result.current.session.tabMirror.current.a.markdown;
    const remark = first.editor.action((ctx) => ctx.get(remarkCtx));
    const parse = vi.spyOn(remark, 'parse');
    act(() => hook.result.current.session.selectTab('b'));
    expect(parse).not.toHaveBeenCalled();

    // A background synchronization can replace both the document and its selection before persistence.
    act(() => {
      first.view.dispatch(first.view.state.tr.insertText('background ', 1));
      first.view.dispatch(
        first.view.state.tr.setSelection(TextSelection.create(first.view.state.doc, 1)),
      );
      hook.result.current.view.handleTabUpdate('a', getCurrentState(first.editor));
    });
    const place = hook.result.current.session.captureTabPlace('a');
    expect(parse).toHaveBeenCalledExactlyOnceWith(departedMarkdown);
    expect(place).toMatchObject({
      sourceMode: false,
      direction: 'backward',
      start: { offset: departedMarkdown.indexOf('selected target') },
      end: { offset: departedMarkdown.indexOf('selected target') + 15 },
    });
    expect(hook.result.current.session.captureTabPlace('a')).toBe(place);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(hook.result.current.session.positions.current.a.sessionCapture).toBeUndefined();
  });

  it('reuses positioned blocks until the Markdown or rich document changes', async () => {
    const markdown = '# Heading\n\nBody text.\n';
    const fixture = await createFixture(markdown);
    const remark = fixture.editor.action((ctx) => ctx.get(remarkCtx));
    const parse = vi.spyOn(remark, 'parse');
    const first = renderedSessionPlace(fixture.editor, markdown);
    expect(renderedSessionPlace(fixture.editor, markdown)).toEqual(first);
    expect(parse).toHaveBeenCalledExactlyOnceWith(markdown);
    fixture.view.dispatch(fixture.view.state.tr.insertText(' changed', 2));
    renderedSessionPlace(fixture.editor, markdown);
    expect(parse).toHaveBeenCalledTimes(2);
    renderedSessionPlace(fixture.editor, markdown + '\n');
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it('reuses unchanged source exchanges without parsing or serializing on mode return', async () => {
    const markdown = '# Same document\n\nBody text.\n';
    const fixture = await createFixture(markdown);
    const hook = setup([initialTab('a', markdown)]);
    const input = document.createElement('textarea');
    input.value = markdown;
    document.body.append(input);
    hook.result.current.session.editorRegistry.current.a = fixture.editor;
    hook.result.current.session.sourceRegistry.current.a = input;
    hook.result.current.session.positions.current.a = {
      exchange: { markdown, source: sourcePlace(input), rendered: renderedPlace(fixture.editor) },
    };
    const doc = fixture.view.state.doc;
    act(() => hook.result.current.session.setSourceMode(true));
    act(() => hook.result.current.view.toggleSourceMode());
    expect(fixture.parse).not.toHaveBeenCalled();
    expect(fixture.serialize).not.toHaveBeenCalled();
    expect(fixture.view.state.doc).toBe(doc);
    expect(hook.result.current.session.resolveContent(hook.result.current.session.activeTab!)).toBe(
      markdown,
    );
  });

  it('still parses source edits when returning to rich mode, then skips later tab activation', async () => {
    const first = await createFixture('Original rich text.\n');
    const second = await createFixture('Other document.\n');
    const hook = setup([
      initialTab('a', 'Original rich text.\n'),
      initialTab('b', 'Other document.\n'),
    ]);
    hook.result.current.session.editorRegistry.current = { a: first.editor, b: second.editor };
    const input = document.createElement('textarea');
    document.body.append(input);
    hook.result.current.session.sourceRegistry.current.a = input;
    act(() => hook.result.current.session.setSourceMode(true));
    input.value = '# Updated source\n\nLatest source edit.\n';
    act(() => hook.result.current.view.handleSourceChange('a', input.value));
    expect(first.view.state.doc.textContent).toBe('Original rich text.');

    act(() => hook.result.current.view.toggleSourceMode());

    expect(first.parse).toHaveBeenCalledExactlyOnceWith(input.value);
    expect(first.view.state.doc.textContent).toContain('Latest source edit.');
    expect(hook.result.current.session.resolveContent(hook.result.current.session.activeTab!)).toBe(
      input.value,
    );
    first.parse.mockClear();
    first.serialize.mockClear();
    act(() => hook.result.current.session.selectTab('b'));
    act(() => hook.result.current.session.selectTab('a'));
    expect(first.parse).not.toHaveBeenCalled();
    expect(first.serialize).not.toHaveBeenCalled();
  });

  it('retains live rich edits, outline and undo state through ordinary tab switches', async () => {
    const markdown = '# Original\n\nBody.\n';
    const first = await createFixture(markdown);
    const second = await createFixture('Other document.\n');
    const hook = setup([initialTab('a', markdown), initialTab('b', 'Other document.\n')]);
    hook.result.current.session.editorRegistry.current = { a: first.editor, b: second.editor };
    act(() => {
      first.view.dispatch(first.view.state.tr.insertText(' changed', 9));
      hook.result.current.view.handleTabUpdate('a', getCurrentState(first.editor));
    });
    const editedDoc = first.view.state.doc;
    const depth = undoDepth(first.view.state);
    first.parse.mockClear();
    first.serialize.mockClear();

    act(() => hook.result.current.session.selectTab('b'));
    act(() => hook.result.current.session.selectTab('a'));

    expect(first.view.state.doc).toBe(editedDoc);
    expect(undoDepth(first.view.state)).toBe(depth);
    expect(first.parse).not.toHaveBeenCalled();
    expect(first.serialize).not.toHaveBeenCalled();
    expect(hook.result.current.session.tabMirror.current.a.outline[0].text).toBe(
      'Original changed',
    );
    expect(hook.result.current.session.tabMirror.current.a.canUndo).toBe(true);
    expect(hook.result.current.session.tabsRef.current[0].dirty).toBe(true);
    act(() => {
      undo(first.editor);
      hook.result.current.view.handleTabUpdate('a', getCurrentState(first.editor));
    });
    expect(hook.result.current.session.tabMirror.current.a.markdown).toBe(markdown);
    expect(hook.result.current.session.tabMirror.current.a.canRedo).toBe(true);
  });

  it('keeps per-edit generations and recomputes dirty state for coalesced snapshots', () => {
    vi.useFakeTimers();
    const original = '# Original\n';
    const hook = setup([initialTab('a', original)]);
    const activity = { canUndo: true, canRedo: false };
    act(() => {
      hook.result.current.view.handleEditorActivity('a', activity);
      hook.result.current.view.handleEditorActivity('a', activity);
    });
    expect(hook.result.current.session.contentGenerations.current.a).toBe(2);
    expect(hook.result.current.session.tabsRef.current[0].dirty).toBe(true);
    expect(hook.result.current.session.tabsRef.current[0].markdown).toBe(original);
    expect(hook.recovery.protectDraft).not.toHaveBeenCalled();

    const update = (markdown: string): EditorUpdate => ({
      markdown,
      outline: [],
      stats: computeStats(markdown),
      ...activity,
    });
    act(() => hook.result.current.view.handleTabUpdate('a', update('# Changed\n'), false, true));
    expect(hook.result.current.session.contentGenerations.current.a).toBe(2);
    expect(hook.result.current.session.tabsRef.current[0].markdown).toBe('# Changed\n');
    expect(hook.recovery.protectDraft).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: '# Changed\n' }),
    );

    act(() => {
      hook.result.current.view.handleEditorActivity('a', activity);
      hook.result.current.view.handleTabUpdate('a', update(original), false, true);
    });
    expect(hook.result.current.session.contentGenerations.current.a).toBe(3);
    expect(hook.result.current.session.tabsRef.current[0].dirty).toBe(false);
  });

  it('keeps explicit image identity synchronization active even when Markdown text is unchanged', async () => {
    const markdown = '![image](./assets/image.png)\n';
    let identity = 'mdplus-image:first';
    const fixture = await createFixture(markdown, () => identity);
    const hook = setup([initialTab('a', markdown)]);
    hook.result.current.session.editorRegistry.current.a = fixture.editor;
    act(() => hook.result.current.session.syncEditor('a', markdown, false));
    const previousDoc = fixture.view.state.doc;
    fixture.parse.mockClear();
    identity = 'mdplus-image:replacement';

    act(() => hook.result.current.session.syncEditor('a', markdown, false));

    expect(fixture.parse).toHaveBeenCalledExactlyOnceWith(markdown);
    expect(fixture.view.state.doc).not.toBe(previousDoc);
    const images: string[] = [];
    fixture.view.state.doc.descendants((node) => {
      if (node.type.name === 'image') images.push(node.attrs.src);
    });
    expect(images).toEqual(['mdplus-image:replacement']);
    expect(hook.result.current.session.tabsRef.current[0].markdown).toBe(markdown);
  });

  it('synchronizes a late or replacement editor with newer source before publishing initial metadata', async () => {
    const current = initialTab('a', 'Initial source.\n');
    const hook = setup([current]);
    const latest = '# Latest source\n\nUnsaved edit before the editor was ready.\n';
    act(() => hook.result.current.view.handleSourceChange('a', latest));
    for (let attempt = 0; attempt < 2; attempt++) {
      const fixture = await createFixture(current.initialContent);
      hook.result.current.session.editorRegistry.current.a = fixture.editor;
      const initial = getCurrentState(fixture.editor);
      fixture.parse.mockClear();
      act(() => hook.result.current.view.handleTabUpdate('a', initial, true));

      expect(fixture.parse).toHaveBeenCalledExactlyOnceWith(latest);
      expect(fixture.view.state.doc.textContent).toContain(
        'Unsaved edit before the editor was ready.',
      );
      expect(hook.result.current.session.tabsRef.current[0].markdown).toBe(latest);
      expect(hook.result.current.session.tabsRef.current[0].dirty).toBe(true);
    }
  });

  it('adopts saved image migration completed before editor registration at generation zero', async () => {
    const original = '![photo](./img/photo.png)\n';
    const migrated = '![photo](./assets/photo-new.png)\n';
    const current = { ...initialTab('a', original), path: 'C:/notes/note.md', isNew: false };
    const hook = setup([current, initialTab('b', 'Other document.\n')]);
    act(() => {
      hook.result.current.session.contentGenerations.current.a = 0;
      // Save As updates the authoritative draft even when sync cannot reach an
      // editor yet. EditorTab still initializes from the original source.
      hook.result.current.session.syncEditor('a', migrated, false);
      hook.result.current.session.tabMirror.current.a = {
        markdown: migrated,
        outline: [],
        stats: computeStats(migrated),
        canUndo: false,
        canRedo: false,
      };
      hook.result.current.session.updateTab('a', {
        path: 'C:/copies/note.md',
        markdown: migrated,
        savedContent: migrated,
        stats: computeStats(migrated),
        dirty: false,
      });
    });
    expect(hook.result.current.session.editorRegistry.current.a).toBeUndefined();
    const fixture = await createFixture(current.initialContent);
    const staleDoc = fixture.view.state.doc;
    const initial = getCurrentState(fixture.editor);
    fixture.parse.mockClear();
    fixture.serialize.mockClear();

    act(() => {
      hook.result.current.view.registerEditor('a', fixture.editor);
      hook.result.current.view.handleTabUpdate('a', initial, true);
    });

    const images: string[] = [];
    fixture.view.state.doc.descendants((node) => {
      if (node.type.name === 'image') images.push(node.attrs.src);
    });
    expect(images).toEqual(['./assets/photo-new.png']);
    expect(fixture.view.dom.querySelector('img[src]')?.getAttribute('src')).toBe(
      './assets/photo-new.png',
    );
    expect(fixture.view.state.doc).not.toBe(staleDoc);
    expect(fixture.parse).toHaveBeenCalledExactlyOnceWith(migrated);
    expect(undoDepth(fixture.view.state)).toBe(0);
    expect(hook.result.current.session.contentGenerations.current.a).toBe(0);
    expect(hook.result.current.session.tabMirror.current.a.markdown).toBe(migrated);
    expect(hook.result.current.session.tabsRef.current[0]).toMatchObject({
      path: 'C:/copies/note.md',
      markdown: migrated,
      savedContent: migrated,
      initialContent: original,
      dirty: false,
    });
    fixture.parse.mockClear();
    fixture.serialize.mockClear();
    act(() => hook.result.current.session.selectTab('b'));
    act(() => hook.result.current.session.selectTab('a'));
    expect(fixture.parse).not.toHaveBeenCalled();
    expect(fixture.serialize).not.toHaveBeenCalled();
  });

  it('preserves unchanged raw source without an extra parse during generation-zero initialization', async () => {
    const raw = '\n\n[Reference][target]\n\n[target]: https://example.com\n';
    const hook = setup([initialTab('a', raw)]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const fixture = await createFixture(raw);
      const initial = getCurrentState(fixture.editor);
      expect(initial.markdown).not.toBe(raw);
      fixture.parse.mockClear();
      fixture.serialize.mockClear();

      act(() => {
        hook.result.current.view.registerEditor('a', fixture.editor);
        hook.result.current.view.handleTabUpdate('a', initial, true);
      });

      expect(fixture.parse).not.toHaveBeenCalled();
      expect(fixture.serialize).not.toHaveBeenCalled();
      expect(hook.result.current.session.contentGenerations.current.a).toBe(0);
      expect(hook.result.current.session.tabMirror.current.a.markdown).toBe(raw);
      expect(hook.result.current.session.tabsRef.current[0]).toMatchObject({
        markdown: raw,
        initialContent: raw,
        savedContent: raw,
        dirty: false,
      });
    }
  });
});
