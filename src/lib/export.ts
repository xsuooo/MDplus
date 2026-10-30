import { save } from '@tauri-apps/plugin-dialog';
import { DOMSerializer } from '@milkdown/prose/model';
import { parserCtx, type Editor } from '@milkdown/kit/core';
import katex from 'katex';
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import { writeFile } from './fileOps';
import { confirmDialog } from './dialog';
import { BODY_FONTS, CODE_FONTS, type BodyFont, type CodeFont } from './editorFont';
import { embeddedFonts, dataURL } from './fontResources';
import { renderDiagramMedia } from './diagramRender';
import documentCSS from '../styles/document.css?raw';
import katexCSS from 'katex/dist/katex.min.css?raw';
import prismCSS from 'prismjs/themes/prism.css?raw';
import katexLicense from 'katex/LICENSE?raw';
import mermaidLicense from 'mermaid/LICENSE?raw';

const mathFonts = import.meta.glob('/node_modules/katex/dist/fonts/*.woff2', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export interface ExportSnapshot {
  title: string;
  content: HTMLElement;
  bodyFont: BodyFont;
  codeFont: CodeFont;
}

/** Capture parser/model data and image bytes synchronously, before any dialog/await. */
export function captureExport(editor: Editor, markdown: string, title: string, bodyFont: BodyFont, codeFont: CodeFont,
  resolveImage: (src: string) => string): ExportSnapshot {
  const content = document.createElement('div');
  content.className = 'ProseMirror';
  editor.action((ctx) => {
    const doc = ctx.get(parserCtx)(markdown);
    if (!doc) throw new Error('无法解析当前文档');
    const serializer = DOMSerializer.fromSchema(doc.type.schema);
    const nodes = { ...serializer.nodes };
    nodes.code_block = (node) => ['pre', ['code', { 'data-language': String(node.attrs.language ?? '') }, node.textContent]];
    for (const name of ['math_inline', 'math_block']) {
      nodes[name] = (node) => {
        const element = document.createElement(name === 'math_inline' ? 'span' : 'div');
        element.innerHTML = katex.renderToString(name === 'math_inline' ? node.textContent : node.attrs.value,
          { displayMode: name === 'math_block', throwOnError: true, trust: false });
        return element;
      };
    }
    const listItem = nodes.list_item;
    nodes.list_item = (node) => {
      if (typeof node.attrs.checked !== 'boolean') return listItem(node);
      const dom = document.createElement('li'), text = document.createElement('div'), box = document.createElement('input');
      box.type = 'checkbox'; box.disabled = true; box.className = 'md-task-checkbox';
      if (node.attrs.checked) box.setAttribute('checked', '');
      dom.append(box, text);
      return { dom, contentDOM: text };
    };
    content.append(new DOMSerializer(nodes, serializer.marks).serializeFragment(doc.content));
  });
  content.querySelectorAll('img').forEach((image) => {
    image.src = resolveImage(image.getAttribute('src') ?? '');
    image.removeAttribute('srcset'); image.loading = 'eager';
  });
  content.querySelectorAll('p').forEach((paragraph) => {
    if (paragraph.querySelector('img') && [...paragraph.childNodes].every((node) =>
      node.nodeType === Node.TEXT_NODE ? !node.textContent?.trim() : node instanceof Element && (
        ['IMG', 'BR'].includes(node.tagName)
        // Milkdown serializes a soft break as a whitespace span, not a BR.
        || (node.matches('span[data-type="hardbreak"]') && !node.textContent?.trim())
      ))) {
      paragraph.classList.add('md-image-only');
    }
  });
  content.querySelectorAll('a').forEach((link) => {
    if (!/^(https?:|mailto:|#)/i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
    link.setAttribute('rel', 'noopener noreferrer');
  });
  return { title, content, bodyFont, codeFont };
}

function escapeHTML(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

async function mathCSS(): Promise<string> {
  let css = katexCSS;
  for (const [face] of katexCSS.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    const file = face.match(/url\((?:["']?)(?:fonts\/)?([^)"']+\.woff2)/)?.[1];
    if (!file) throw new Error('公式字体清单不完整');
    const src = await dataURL(mathFonts[`/node_modules/katex/dist/fonts/${file}`]);
    css = css.replace(face, face.replace(/src:[^;}]*/, `src:url("${src}") format("woff2")`));
  }
  return css;
}

export async function buildExport(snapshot: ExportSnapshot): Promise<string> {
  const content = snapshot.content.cloneNode(true) as HTMLElement;
  const body = BODY_FONTS.find((font) => font.id === snapshot.bodyFont)!;
  const code = CODE_FONTS.find((font) => font.id === snapshot.codeFont)!;
  const fonts = await embeddedFonts(snapshot.bodyFont, snapshot.codeFont);
  for (const block of content.querySelectorAll<HTMLElement>('pre > code[data-language]')) {
    const language = block.dataset.language!.toLowerCase();
    if (language === 'mermaid') {
      const media = await renderDiagramMedia(block.textContent ?? '', 'light', snapshot.bodyFont);
      const svg = new DOMParser().parseFromString(media.svg, 'text/html').querySelector('svg')!;
      svg.style.cssText = `width:${media.width}px;max-width:100%;height:auto`;
      const diagram = document.createElement('div'); diagram.className = 'export-diagram';
      diagram.append(svg); block.parentElement!.replaceWith(diagram);
    } else if (Prism.languages[language]) {
      block.innerHTML = Prism.highlight(block.textContent ?? '', Prism.languages[language], language);
    }
  }
  // A local/missing/remote resource is a failed export, never an empty placeholder.
  for (const image of content.querySelectorAll('img, image')) {
    const attr = image.tagName.toLowerCase() === 'img' ? 'src' : 'href';
    const src = image.getAttribute(attr) ?? image.getAttribute('xlink:href') ?? '';
    if (!/^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml|avif|x-icon)[;,]/i.test(src)) {
      throw new Error(`图片尚未内嵌或不可读取：${src.slice(0, 160)}。请修复图片后重试。`);
    }
    const probe = new Image(); probe.src = src;
    try { await probe.decode(); } catch { throw new Error('图片数据无法解码，已中止导出'); }
  }
  for (const element of content.querySelectorAll('style, [style]')) {
    const css = element.tagName.toLowerCase() === 'style' ? element.textContent ?? '' : element.getAttribute('style') ?? '';
    if (/@import/i.test(css) || [...css.matchAll(/url\(\s*["']?([^)"']+)/gi)].some((match) => !/^(#|data:)/i.test(match[1]))) {
      throw new Error('图表包含外部样式资源，无法保证离线完整性');
    }
  }
  const notices: string[] = [];
  for (const license of fonts.licenses) {
    const url = new URL(`/font-licenses/${license}`, document.baseURI).href;
    if (license.endsWith('.pdf')) notices.push(`<p>本作品使用 MiSans，版权归 Xiaomi Technology Co., Ltd.。<a download="MiSans-License.pdf" href="${await dataURL(url)}">完整字体许可协议（内嵌 PDF）</a></p>`);
    else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`无法保留字体许可：${license}`);
      notices.push(`<pre>${escapeHTML(await response.text())}</pre>`);
    }
  }
  const math = content.querySelector('.katex') ? await mathCSS() : '';
  if (math) notices.push(`<pre>${escapeHTML(katexLicense)}</pre>`);
  if (content.querySelector('.export-diagram')) notices.push(`<pre>${escapeHTML(mermaidLicense)}</pre>`);
  const css = `
    :root { color-scheme:light; --font-body:${body.family}; --font-code:${code.family}; --body-strong-weight:${body.strongWeight};
      --reading-leading:1.75; --code-leading:1.6; --code-size:14px; --radius:7px; --radius-sm:5px;
      --text:#344054; --text-strong:#172333; --text-muted:#667085; --border:#dce4ea; --border-strong:#c7d3dc;
      --accent:#0f766e; --accent-text:#0b615b; --accent-soft:#d4e9e5; --code-bg:#edf2f6; --code-text:#334155;
      --quote-bg:#f1f6f7; --quote-border:#b9d7d5; --table-stripe:#f2f6f8; }
    * { box-sizing:border-box; } body { margin:32px auto; padding:0 24px; max-width:768px; background:white; font:16px/1.75 ${body.family}; }
    ${fonts.css}\n${documentCSS}\n${prismCSS}\n${math}
    .milkdown .ProseMirror { outline:none; } .milkdown .ProseMirror p.md-image-only > img { width:auto; }
    .export-diagram { margin:1.2em 0; text-align:center; break-inside:avoid; } .export-diagram svg { display:block; margin:auto; }
    .milkdown .ProseMirror pre { white-space:pre-wrap; overflow-wrap:anywhere; }
    .milkdown .ProseMirror pre code { white-space:inherit; } .milkdown .ProseMirror .tableWrapper { overflow:visible; }
    .milkdown .ProseMirror table { table-layout:fixed; } .milkdown .ProseMirror th, .milkdown .ProseMirror td { overflow-wrap:anywhere; }
    .export-notices { margin-top:40px; font:12px/1.5 sans-serif; color:#667085; } .export-notices pre { white-space:pre-wrap; }
    @page { margin:16mm; } @media print { body { margin:0; padding:0; max-width:none; } .export-notices { display:none; }
      h1,h2,h3,h4,h5,h6 { break-after:avoid; } p { orphans:3; widows:3; } tr, img { break-inside:avoid; }
      .milkdown .ProseMirror img, .export-diagram svg { max-height:245mm; object-fit:contain; }
      * { print-color-adjust:exact; -webkit-print-color-adjust:exact; } }
  `;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
    <title>${escapeHTML(snapshot.title)}</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head>
    <body><main class="milkdown">${content.outerHTML}</main><details class="export-notices"><summary>内嵌字体许可</summary>${notices.join('\n')}</details></body></html>`;
}

/** Returns false on cancellation; callers must not announce a successful write. */
export async function exportHTML(snapshot: ExportSnapshot): Promise<boolean> {
  const html = await buildExport(snapshot);
  const mb = new Blob([html]).size / 1024 / 1024;
  if (!await confirmDialog(`将导出可离线打开的单文件 HTML，包含字体、图片、公式和图表，约 ${mb.toFixed(1)} MB。继续？`)) return false;
  const path = await save({ defaultPath: `${snapshot.title.replace(/\.(md|markdown)$/i, '')}.html`,
    filters: [{ name: 'HTML', extensions: ['html'] }], title: '导出 HTML' });
  if (!path) return false;
  await writeFile(path, html);
  return true;
}

/** Print the same frozen, fully-loaded light document without touching the editor. */
export async function exportPDF(snapshot: ExportSnapshot): Promise<void> {
  const html = await buildExport(snapshot);
  // Tauri adds CSP style hashes. Apply trusted generated styles through CSSOM
  // instead of relaxing the host CSP or letting inherited hashes block srcdoc.
  const shell = new DOMParser().parseFromString(html, 'text/html');
  const rules = [...shell.querySelectorAll('style')].map((style) => { const css = style.textContent ?? ''; style.remove(); return css; }).join('\n');
  shell.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    element.setAttribute('data-print-style', element.getAttribute('style')!); element.removeAttribute('style');
  });
  const frame = document.createElement('iframe');
  frame.className = 'export-print-frame';
  frame.title = 'PDF 导出预览';
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0';
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('打印页面加载超时')), 30000);
      frame.onload = () => { clearTimeout(timer); resolve(); };
    });
    frame.srcdoc = shell.documentElement.outerHTML; document.body.append(frame); await loaded;
    const doc = frame.contentDocument!, win = frame.contentWindow!;
    const Sheet = (win as unknown as { CSSStyleSheet: typeof CSSStyleSheet }).CSSStyleSheet;
    const sheet = new Sheet(); sheet.replaceSync(rules); doc.adoptedStyleSheets = [sheet];
    doc.querySelectorAll<HTMLElement>('[data-print-style]').forEach((element) => {
      element.style.cssText = element.getAttribute('data-print-style')!; element.removeAttribute('data-print-style');
    });
    // Font loading starts during layout, not merely when the stylesheet is adopted.
    void doc.body.offsetHeight;
    await doc.fonts.ready;
    await Promise.all([...doc.images].map((image) => image.decode()));
    await new Promise<void>((resolve, reject) => {
      const finish = () => { win.removeEventListener('afterprint', finish); resolve(); };
      win.addEventListener('afterprint', finish, { once: true });
      try { win.print(); } catch (error) { win.removeEventListener('afterprint', finish); reject(error); }
    });
  } finally { frame.remove(); }
}
