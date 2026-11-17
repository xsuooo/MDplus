import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  BODY_FONTS,
  CODE_FONTS,
  readBodyFont,
  readCodeFont,
  writeBodyFont,
  writeCodeFont,
  type BodyFont,
  type CodeFont,
} from '../lib/editorFont';
import { readEditorWidth, writeEditorWidth, type EditorWidth } from '../lib/editorWidth';
import { refreshMermaidTheme } from '../lib/mermaid';
import {
  onUserInput,
  restoreRendered,
  restoreSource,
  type RenderedPlace,
  type SourcePlace,
} from '../lib/position/editorPosition';

import type { Workspace } from './useWorkspace';

/**
 * Body font, code font and editor width. A change reflows the document, so the reading position is
 * captured before it and restored after the new fonts have loaded.
 * Call before useEditorView: its layout effects must run first.
 */
export function useTypography(workspace: Workspace) {
  const { activeId, sourceMode, tabRuntime, currentView, rememberActive } = workspace;
  const [codeFont, setCodeFont] = useState(readCodeFont);
  const [bodyFont, setBodyFont] = useState(readBodyFont);
  const [editorWidth, setEditorWidth] = useState(readEditorWidth);
  useEffect(() => {
    void refreshMermaidTheme();
  }, [bodyFont]);
  const fontPosition = useRef<{
    id: string;
    source?: SourcePlace;
    rendered?: RenderedPlace;
  } | null>(null);
  const captureFontPosition = useCallback(() => {
    rememberActive();
    const { activeId: id, sourceMode: source } = currentView.current;
    if (id) {
      const saved = tabRuntime.current[id]?.position;
      fontPosition.current = {
        id,
        source: source ? saved?.source : undefined,
        rendered: source ? undefined : saved?.rendered,
      };
    }
  }, [currentView, tabRuntime, rememberActive]);
  const changeBodyFont = useCallback(
    (font: BodyFont) => {
      if (font === bodyFont) return;
      captureFontPosition();
      setBodyFont(font);
    },
    [bodyFont, captureFontPosition],
  );
  const changeCodeFont = useCallback(
    (font: CodeFont) => {
      if (font === codeFont) return;
      captureFontPosition();
      setCodeFont(font);
    },
    [codeFont, captureFontPosition],
  );
  const changeEditorWidth = useCallback(
    (width: EditorWidth) => {
      if (width === editorWidth) return;
      captureFontPosition();
      setEditorWidth(width);
    },
    [editorWidth, captureFontPosition],
  );

  useLayoutEffect(() => {
    const body = BODY_FONTS.find((font) => font.id === bodyFont)!;
    const code = CODE_FONTS.find((font) => font.id === codeFont)!;
    // Dialogs, drag overlays and the error fallback share these document-wide roles.
    const style = document.documentElement.style;
    style.setProperty('--font-body', `${body.family}, var(--font-sans)`);
    style.setProperty('--body-strong-weight', String(body.strongWeight));
    style.setProperty('--font-code', `${code.family}, var(--font-mono)`);
  }, [bodyFont, codeFont]);

  useLayoutEffect(() => {
    const saved = fontPosition.current;
    fontPosition.current = null;
    if (!saved || saved.id !== activeId) return;
    const restore = () => {
      const input = tabRuntime.current[saved.id]?.sourceInput;
      const editor = tabRuntime.current[saved.id]?.editor;
      if (input && saved.source) restoreSource(input, saved.source);
      if (editor && saved.rendered) restoreRendered(editor, saved.rendered);
    };
    restore();
    let cancelled = false;
    const cancel = (event: Event) => {
      const target = event.target;
      // Radio selection emits input after React installs this effect; it is not a document edit.
      if (
        event.type === 'input' &&
        target instanceof HTMLInputElement &&
        target.type === 'radio' &&
        target.name === 'code-font'
      )
        return;
      cancelled = true;
    };
    const stopListening = onUserInput(cancel);
    const body = BODY_FONTS.find((font) => font.id === bodyFont)!;
    const families = [
      body.family,
      ...CODE_FONTS.find((font) => font.id === codeFont)!.family.split(', '),
    ];
    void Promise.allSettled([
      ...families.map((family) => document.fonts.load(`400 16px ${family}`, '中文 Mixed')),
      document.fonts.load(`${body.strongWeight} 16px ${body.family}`, '中文 Bold'),
    ]).then(() => {
      if (!cancelled) restore();
    });
    return () => {
      cancelled = true;
      stopListening();
    };
  }, [bodyFont, codeFont, editorWidth, activeId, sourceMode, tabRuntime]);
  useEffect(() => {
    writeCodeFont(codeFont);
  }, [codeFont]);
  useEffect(() => {
    writeBodyFont(bodyFont);
  }, [bodyFont]);
  useEffect(() => {
    writeEditorWidth(editorWidth);
  }, [editorWidth]);

  return {
    bodyFont,
    codeFont,
    editorWidth,
    changeBodyFont,
    changeCodeFont,
    changeEditorWidth,
  };
}
