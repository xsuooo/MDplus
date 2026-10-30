import { createEditor, getCurrentState, setMarkdown } from '../../src/lib/editor';
import { captureExport, buildExport, exportHTML, exportPDF } from '../../src/lib/export';
import { renderDiagramMedia } from '../../src/lib/diagramRender';
import { mockIPC } from '@tauri-apps/api/mocks';
import '../../src/styles/global.css';

export const exportCases = ['export-offline', 'export-frozen-source', 'export-cancel', 'export-missing-image',
  'export-invalid-diagram', 'export-print-isolation', 'export-print-csp', 'export-preview-csp', 'export-diagram-fonts', 'export-diagram-bounds', 'export-security', 'export-image-alignment'] as const;
export type ExportCase = typeof exportCases[number];
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(test: () => unknown) {
  const end = performance.now() + 60000;
  while (!test()) { check(performance.now() < end, 'Export test timed out'); await new Promise((resolve) => setTimeout(resolve, 30)); }
}
export const exportDocument = `# 离线导出 Offline export

正文 English 与中文，**重点**及 \`inline code\`。

![中文图片](data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="70"><rect width="120" height="70" fill="teal"/></svg>')})

- [x] 已完成
- [ ] 未完成

| Name | 说明 |
| --- | --- |
| Item | 中文 English |

\`\`\`typescript
const title = "中文导出";
\`\`\`

行内公式 $e^{i\\pi}+1=0$。

$$
\\frac{1}{2}+\\sqrt{x^2+y^2}
$$

\`\`\`mermaid
graph LR
A[中文起点]-->B[English endpoint]
\`\`\`

最后一段 END-OF-DOCUMENT
`;

export async function runExportRegression(testCase: ExportCase): Promise<string> {
  document.documentElement.dataset.theme = 'dark';
  const host = document.createElement('div'); host.className = 'milkdown-container'; document.body.append(host);
  const editor = createEditor(host, '# Original', { onUpdate: () => {} }); await editor.create();
  let writes = 0, confirmations = 0;
  const resources: HTMLElement[] = [];
  try {
  const snapshot = captureExport(editor, exportDocument + '\n\n' + '长文校验 Long document paragraph.\n\n'.repeat(30),
    '导出 <title>.md', 'misans', 'jetbrains-sarasa', (src) => src);
    if (testCase === 'export-image-alignment') {
      const image = `![](data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="70"><rect width="120" height="70" fill="teal"/></svg>')})`;
      const markdown = `${image}\n${image}\n\n${image}  \n${image}\n\nBefore ${image}\nafter`;
      const sample = captureExport(editor, markdown, 'images', 'misans', 'jetbrains-sarasa', (src) => src);
      check(sample.content.querySelectorAll('p.md-image-only').length === 2, 'Soft/hard breaks between standalone images lost centered layout');
      check(!sample.content.querySelector('p:last-child')!.classList.contains('md-image-only'), 'Inline image was pulled out of prose');
      const frame = document.createElement('iframe'); resources.push(frame);
      frame.style.cssText = 'width:1000px;height:900px'; frame.srcdoc = await buildExport(sample); document.body.append(frame);
      await until(() => frame.contentDocument?.querySelectorAll('img').length === 5);
      const doc = frame.contentDocument!, view = frame.contentWindow!;
      await doc.fonts.ready; await Promise.all([...doc.images].map((image) => image.decode()));
      for (const paragraph of doc.querySelectorAll('p.md-image-only')) {
        const box = paragraph.getBoundingClientRect(); let bottom = box.top;
        for (const image of paragraph.querySelectorAll('img')) {
          const rect = image.getBoundingClientRect();
          check(Math.abs(rect.x + rect.width / 2 - box.x - box.width / 2) < 1, 'Export image is not centered');
          check(rect.top >= bottom, 'Consecutive export images are not stacked'); bottom = rect.bottom;
        }
      }
      check(view.getComputedStyle(doc.querySelector('p:last-child img')!).display === 'inline', 'Inline export image became block-level');
    } else if (testCase === 'export-frozen-source') {
      setMarkdown(editor, '# Edited later');
      const html = await buildExport(snapshot);
      check(html.includes('END-OF-DOCUMENT') && !html.includes('Edited later'), 'Export used changed active editor');
      check(getCurrentState(editor).markdown.includes('Edited later'), 'Export modified the live editor');
    } else if (testCase === 'export-cancel') {
      mockIPC((command) => {
        if (command === 'plugin:dialog|message') { confirmations++; return 'Yes'; }
        if (command === 'plugin:dialog|save') return null;
        if (command === 'write_file') writes++;
      });
      check(await exportHTML(snapshot) === false && writes === 0 && confirmations === 1, 'Cancelled export reported success or wrote a file');
    } else if (testCase === 'export-missing-image') {
      const failed = captureExport(editor, '![](./missing.png)', 'missing', 'misans', 'jetbrains-sarasa', (src) => src);
      let rejected = false;
      try { await buildExport(failed); } catch { rejected = true; }
      check(rejected, 'Missing image was silently omitted');
    } else if (testCase === 'export-invalid-diagram') {
      const failed = captureExport(editor, '```mermaid\nnot valid diagram\n```', 'broken', 'misans', 'jetbrains-sarasa', (src) => src);
      let rejected = false;
      try { await buildExport(failed); } catch { rejected = true; }
      check(rejected, 'Broken diagram was silently omitted');
    } else if (testCase === 'export-preview-csp') {
      const policy = document.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
      policy.content = "style-src 'self' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; connect-src 'self'; img-src 'self' data:; font-src 'self' data:";
      document.head.append(policy); resources.push(policy);
      const media = await renderDiagramMedia('graph LR\nA[中文起点]-->B[English endpoint]', 'dark', 'wenkai');
      const image = new Image(); image.src = media.src; resources.push(image); document.body.append(image);
      await image.decode();
      check(media.src.startsWith('data:image/svg+xml') && image.naturalWidth > 100 && image.naturalHeight < 200,
        'Packaged-style CSP prevented inert diagram image decoding');
    } else if (testCase === 'export-diagram-bounds') {
      for (const code of ['graph LR\nA[中文起点]-->B[English endpoint]',
        '---\ntitle: 图表标题\n---\ngraph TD\nsubgraph 中文分组\nA[第一行<br/>第二行]-->B{Decision?}\nend\nB-->|Yes|C[Finish]']) {
        const media = await renderDiagramMedia(code, 'light', 'misans');
        check(media.width > 100 && media.width < 900 && media.height > 50 && media.height < 600, 'Final diagram bounds retain temporary measurement boxes');
        const container = document.createElement('div'); container.innerHTML = media.svg; document.body.append(container); resources.push(container);
        const svg = container.querySelector('svg')!, bounds = svg.getBBox(), box = svg.viewBox.baseVal;
        check(box.x <= bounds.x && box.y <= bounds.y && box.x + box.width >= bounds.x + bounds.width
          && box.y + box.height >= bounds.y + bounds.height, 'Diagram title, groups or nodes clipped by final bounds');
      }
    } else if (testCase === 'export-diagram-fonts') {
      for (const [font, family] of [['misans', 'MDPlus MiSans'], ['wenkai', 'MDPlus LXGW WenKai'], ['sarasa', 'MDPlus Sarasa Gothic SC']] as const) {
        const media = await renderDiagramMedia('graph LR\nA[中文 Mixed]-->B[终点]', 'light', font);
        const html = atob(media.src.split(',')[1]);
        check(html.includes(`font-family:${family}`) || html.includes(`font-family: &quot;${family}`) || html.includes(`font-family:"${family}"`), 'Diagram family missing');
        check(html.includes('@font-face') && html.includes('data:'), 'Diagram font was named but not embedded');
      }
    } else if (testCase === 'export-print-isolation' || testCase === 'export-print-csp') {
      if (testCase === 'export-print-csp') {
        const policy = document.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
        policy.content = "style-src 'self' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; connect-src 'self'; font-src 'self' data:";
        document.head.append(policy); resources.push(policy);
      }
      let printed = false;
      const observer = new MutationObserver(() => {
        const frame = document.querySelector<HTMLIFrameElement>('.export-print-frame');
        if (!frame || frame.dataset.probe) return;
        frame.dataset.probe = 'yes';
        frame.addEventListener('load', () => {
          frame.contentWindow!.print = () => {
            printed = true;
            check(frame.contentDocument!.body.textContent!.includes('END-OF-DOCUMENT'), 'Print snapshot incomplete');
            check(frame.contentWindow!.getComputedStyle(frame.contentDocument!.body).fontFamily.includes('MDPlus MiSans'),
              'Host CSP blocked print typography');
            const svg = frame.contentDocument!.querySelector<SVGSVGElement>('.export-diagram svg')!;
            check(svg.viewBox.baseVal.width < 900 && svg.viewBox.baseVal.height < 200,
              'Host CSP broke diagram label measurement');
            check(document.documentElement.dataset.theme === 'dark', 'Print changed application theme');
            frame.contentWindow!.dispatchEvent(new Event('afterprint'));
          };
        });
      });
      observer.observe(document.body, { childList: true });
      try { await exportPDF(snapshot); } finally { observer.disconnect(); }
      check(printed && !document.querySelector('.export-print-frame'), 'Print lifecycle did not complete cleanup');
    } else {
      const html = await buildExport(snapshot);
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      check(parsed.querySelectorAll('.katex').length === 2, 'Math missing');
      check(parsed.querySelector('.export-diagram svg'), 'Diagram missing');
      check(parsed.querySelectorAll('input[type="checkbox"]').length === 2, 'Task list missing');
      check(!parsed.querySelector('script, iframe, .md-media-controls, [contenteditable]'), 'Editing or executable content leaked into export');
      check(parsed.querySelector('title')!.textContent === '导出 <title>.md', 'Title was not escaped');
      for (const url of html.matchAll(/url\(["']?([^)"']+)/g)) check(url[1].startsWith('data:') || url[1].startsWith('#'), `Nonportable CSS resource: ${url[1]}`);
      check(html.includes('SIL OPEN FONT LICENSE') && html.includes('MiSans-License.pdf'), 'Font license was dropped');
      if (testCase === 'export-security') {
        const hostile = captureExport(editor, '[bad](javascript:alert(1))\n\n<script>alert(1)</script>', 'unsafe', 'misans', 'jetbrains-sarasa', (src) => src);
        const result = new DOMParser().parseFromString(await buildExport(hostile), 'text/html');
        check(!result.querySelector('script, [href^="javascript:"]'), 'Unsafe content reached export');
        const diagram = await renderDiagramMedia('%%{init: {"securityLevel":"loose","secure":[]}}%%\ngraph LR\nA["<img src=x onerror=alert(1)>"]-->B',
          'light', 'misans');
        const svg = new DOMParser().parseFromString(diagram.svg, 'text/html');
        check(!svg.querySelector('script,[onerror],[onclick]'), 'Diagram directives disabled strict sanitization');
      } else {
        const frame = document.createElement('iframe'); resources.push(frame);
        frame.style.cssText = 'width:1000px;height:900px'; frame.srcdoc = html; document.body.append(frame);
        await until(() => frame.contentDocument?.querySelector('.export-diagram'));
        await frame.contentDocument!.fonts.ready;
        await Promise.all([...frame.contentDocument!.images].map((img) => img.decode()));
        const view = frame.contentWindow!, doc = frame.contentDocument!;
        check(view.getComputedStyle(doc.body).backgroundColor === 'rgb(255, 255, 255)', 'Export is not light');
        check(view.getComputedStyle(doc.querySelector('.ProseMirror')!).fontFamily.includes('MDPlus MiSans'), 'Export body font differs');
        check(doc.documentElement.scrollHeight > 900, 'Long export was clipped');
        (window as unknown as { exportedHTML: string }).exportedHTML = html;
      }
    }
    return `${testCase}: passed (frozen Markdown, embedded assets, isolated export)`;
  } finally {
    for (const element of resources) element.remove(); await editor.destroy(); host.remove();
  }
}
