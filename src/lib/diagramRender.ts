import { bodyFamily, embeddedFonts, blobDataURL } from './fontResources';
import type { BodyFont } from './editorFont';
import { diagramPreview, type MediaPreview } from './media';

let queue: Promise<unknown> = Promise.resolve();
let fontCache: { font: BodyFont; promise: ReturnType<typeof embeddedFonts> } | undefined;

export async function renderDiagramMedia(code: string, theme: 'light' | 'dark', font: BodyFont): Promise<MediaPreview & { kind: 'diagram' }> {
  if (fontCache?.font !== font) fontCache = { font, promise: embeddedFonts(font) };
  const pending = fontCache.promise;
  const resources = await pending.catch((error) => {
    if (fontCache?.promise === pending) fontCache = undefined;
    throw error;
  });
  await document.fonts.load(`400 16px ${bodyFamily(font)}`, '中文 Mixed');
  const { default: mermaid } = await import('mermaid');
  const task = queue.then(async () => {
    // Strict rendering measures loaded app fonts; previews use inert SVG images.
    // Never call Mermaid's interactive bindFunctions.
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default',
      suppressErrorRendering: true, fontFamily: bodyFamily(font),
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'fontFamily', 'themeCSS'],
    });
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:720px;opacity:0;pointer-events:none;z-index:-1';
    host.setAttribute('aria-hidden', 'true'); document.body.append(host);
    const sheets = new Set<CSSStyleSheet>();
    const seen = new Set<Element>();
    // Packaged Tauri pages use style hashes: Mermaid's dynamic <style> would
    // otherwise be ignored during label measurement. Apply it as trusted CSSOM.
    const applyStyles = () => {
      for (const style of host.querySelectorAll('style')) {
        if (seen.has(style)) continue;
        seen.add(style);
        const sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent ?? '');
        sheets.add(sheet); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
    };
    const observer = new MutationObserver(applyStyles);
    observer.observe(host, { childList: true, subtree: true });
    try {
      let { svg } = await mermaid.render(`md-mmd-${crypto.randomUUID()}`, code, host);
      const parsed = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
      if (parsed?.classList.contains('flowchart')) {
        // WebView2 can retain Mermaid's temporary label bounds in its live SVG.
        // Measure the completed, strict-sanitized tree with final node positions.
        host.replaceChildren(parsed); applyStyles();
        const bounds = parsed.getBBox();
        const padding = mermaid.mermaidAPI.getConfig().flowchart?.diagramPadding ?? 8;
        parsed.setAttribute('viewBox', `${bounds.x - padding} ${bounds.y - padding} ${bounds.width + 2 * padding} ${bounds.height + 2 * padding}`);
        svg = parsed.outerHTML;
      }
      const { imageSVG, ...preview } = diagramPreview(svg, resources.css);
      return { ...preview, src: await blobDataURL(new Blob([imageSVG], { type: 'image/svg+xml;charset=utf-8' })) };
    } finally {
      observer.disconnect(); host.remove();
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => !sheets.has(sheet));
    }
  });
  queue = task.catch(() => {});
  return task;
}
