import { bodyFamily, embeddedFonts, blobDataURL } from './fontResources';
import { BODY_FONTS, type BodyFont } from './editorFont';
import { diagramPreview, type MediaPreview } from './media';

let queue: Promise<unknown> = Promise.resolve();
type DiagramMedia = MediaPreview & { kind: 'diagram' };
type Consumer = { signal?: AbortSignal };
type RenderRequest = { consumers: Set<Consumer>; promise: Promise<DiagramMedia> };
const fontCache = new Map<BodyFont, ReturnType<typeof embeddedFonts>>();
const requests = new Map<string, RenderRequest>();
const previews = new Map<string, { media: DiagramMedia; bytes: number }>();
// SVG images contain complete fonts. Bound retained results by both count and size.
const MAX_PREVIEWS = 4;
const MAX_PREVIEW_BYTES = 96 * 1024 * 1024;
let previewBytes = 0;

function rememberPreview(key: string, media: DiagramMedia): void {
  const bytes = 2 * (key.length + media.src.length + media.svg.length);
  if (bytes > MAX_PREVIEW_BYTES) return;
  while (previews.size >= MAX_PREVIEWS || previewBytes + bytes > MAX_PREVIEW_BYTES) {
    const oldest = previews.keys().next().value!;
    previewBytes -= previews.get(oldest)!.bytes;
    previews.delete(oldest);
  }
  previews.set(key, { media, bytes });
  previewBytes += bytes;
}

function requireConsumer(isNeeded: () => boolean): void {
  if (!isNeeded()) throw new DOMException('图表渲染已过期', 'AbortError');
}

function hasConsumer(consumers: Set<Consumer>): boolean {
  for (const consumer of consumers) if (!consumer.signal?.aborted) return true;
  return false;
}

/** Let colors and input paint before Mermaid's synchronous layout work. */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    // Animation frames stop in hidden tabs; export must still finish there.
    if (document.visibilityState === 'hidden') {
      setTimeout(resolve, 0);
      return;
    }
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      resolve();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer);
        timer = setTimeout(finish, 0);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Occluded WebViews can pause frames without a visibility event as well.
    timer = setTimeout(finish, 100);
    frame = requestAnimationFrame(() => {
      frame = undefined;
      clearTimeout(timer);
      timer = setTimeout(finish, 0);
    });
  });
}

export async function renderDiagramMedia(
  code: string,
  theme: 'light' | 'dark',
  font: BodyFont,
  options: { signal?: AbortSignal; reuse?: boolean } = {},
): Promise<DiagramMedia> {
  const { signal } = options;
  signal?.throwIfAborted();
  // Inline export SVGs need independent Mermaid IDs. Reuse is safe only for
  // isolated SVG images, so NodeViews opt in and ordinary exports stay fresh.
  if (!options.reuse) return renderUncached(code, theme, font, () => !signal?.aborted);
  const key = JSON.stringify([font, theme, code]);
  const cached = previews.get(key);
  if (cached) {
    previews.delete(key);
    previews.set(key, cached);
    // NodeViews stabilize their own layout; never mutate a shared cached result.
    return { ...cached.media };
  }
  const consumer = { signal };
  let request = requests.get(key);
  if (request && !hasConsumer(request.consumers)) request = undefined;
  if (request) request.consumers.add(consumer);
  else {
    const consumers = new Set([consumer]);
    const isNeeded = () => hasConsumer(consumers);
    const promise = renderUncached(code, theme, font, isNeeded);
    request = { consumers, promise };
    requests.set(key, request);
    const pendingRequest = request;
    void promise
      .then(
        (media) => {
          if (isNeeded()) rememberPreview(key, media);
        },
        () => {},
      )
      .finally(() => {
        if (requests.get(key) === pendingRequest) requests.delete(key);
      });
  }
  try {
    const media = await request.promise;
    signal?.throwIfAborted();
    return { ...media };
  } finally {
    request.consumers.delete(consumer);
  }
}

async function renderUncached(
  code: string,
  theme: 'light' | 'dark',
  font: BodyFont,
  isNeeded: () => boolean,
): Promise<DiagramMedia> {
  await afterPaint();
  requireConsumer(isNeeded);
  let pending = fontCache.get(font);
  if (!pending) {
    pending = embeddedFonts(font);
    fontCache.set(font, pending);
  }
  const fontRequest = pending;
  const resources = await pending.catch((error) => {
    if (fontCache.get(font) === fontRequest) fontCache.delete(font);
    throw error;
  });
  requireConsumer(isNeeded);
  const body = BODY_FONTS.find((entry) => entry.id === font)!;
  await Promise.all([
    document.fonts.load(`400 16px ${body.family}`, '中文 Mixed'),
    document.fonts.load(`${body.strongWeight} 16px ${body.family}`, '中文 Bold'),
  ]);
  await document.fonts.ready;
  requireConsumer(isNeeded);
  const { default: mermaid } = await import('mermaid');
  const task = queue.then(async () => {
    requireConsumer(isNeeded);
    await afterPaint();
    requireConsumer(isNeeded);
    // Strict rendering measures loaded app fonts; previews use inert SVG images.
    // Never call Mermaid's interactive bindFunctions.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'dark' ? 'dark' : 'default',
      suppressErrorRendering: true,
      fontFamily: bodyFamily(font),
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'fontFamily',
        'themeCSS',
      ],
    });
    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;left:0;top:0;width:720px;opacity:0;pointer-events:none;z-index:-1';
    host.setAttribute('aria-hidden', 'true');
    document.body.append(host);
    const sheets = new Set<CSSStyleSheet>();
    const seen = new Set<Element>();
    // Packaged Tauri pages use style hashes: Mermaid's dynamic <style> would
    // otherwise be ignored during label measurement. Apply it as trusted CSSOM.
    const applyStyles = () => {
      for (const style of host.querySelectorAll('style')) {
        if (seen.has(style)) continue;
        seen.add(style);
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(style.textContent ?? '');
        sheets.add(sheet);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
    };
    const observer = new MutationObserver(applyStyles);
    observer.observe(host, { childList: true, subtree: true });
    try {
      let { svg } = await mermaid.render(`md-mmd-${crypto.randomUUID()}`, code, host);
      requireConsumer(isNeeded);
      const parsed = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
      if (parsed?.classList.contains('flowchart')) {
        // WebView2 can retain Mermaid's temporary label bounds in its live SVG.
        // Measure the completed, strict-sanitized tree with final node positions.
        host.replaceChildren(parsed);
        applyStyles();
        parsed.getBoundingClientRect();
        await document.fonts.ready;
        requireConsumer(isNeeded);
        for (const label of parsed.querySelectorAll('foreignObject')) {
          const content = label.firstElementChild;
          const matrix = label.getScreenCTM();
          if (!(content instanceof HTMLElement) || !matrix) continue;
          // Shrink HTML content before replacing a leaked measurement box.
          content.style.display = 'inline-block';
          const box = content.getBoundingClientRect();
          const scaleX = Math.hypot(matrix.a, matrix.b),
            scaleY = Math.hypot(matrix.c, matrix.d);
          if (scaleX > 0 && scaleY > 0) {
            label.setAttribute('width', String(box.width / scaleX));
            label.setAttribute('height', String(box.height / scaleY));
          }
        }
        const title = parsed.querySelector('text.flowchartTitleText');
        if (title) {
          // Mermaid can center the title on its temporary 16384px label bounds.
          const parent = title.parentNode!,
            next = title.nextSibling;
          title.remove();
          const graph = parsed.getBBox();
          title.setAttribute('x', String(graph.x + graph.width / 2));
          parent.insertBefore(title, next);
        }
        const bounds = parsed.getBBox();
        const padding = mermaid.mermaidAPI.getConfig().flowchart?.diagramPadding ?? 8;
        parsed.setAttribute(
          'viewBox',
          `${bounds.x - padding} ${bounds.y - padding} ${bounds.width + 2 * padding} ${bounds.height + 2 * padding}`,
        );
        svg = parsed.outerHTML;
      }
      requireConsumer(isNeeded);
      const { imageSVG, ...preview } = diagramPreview(svg, resources.css);
      return {
        ...preview,
        src: await blobDataURL(new Blob([imageSVG], { type: 'image/svg+xml;charset=utf-8' })),
      };
    } finally {
      observer.disconnect();
      host.remove();
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (sheet) => !sheets.has(sheet),
      );
    }
  });
  queue = task.catch(() => {});
  return task;
}
