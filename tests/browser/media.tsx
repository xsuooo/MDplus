import { createRoot } from 'react-dom/client';
import { editorViewCtx } from '@milkdown/kit/core';
import { NodeSelection } from '@milkdown/prose/state';
import { createEditor, getCurrentState, undo } from '../../src/lib/editor';
import { MediaViewer } from '../../src/components/MediaViewer';
import { diagramPreview, type MediaPreview } from '../../src/lib/media';
import { captureExport, buildExport } from '../../src/lib/export';
import App from '../../src/App';
import '../../src/styles/global.css';

export const mediaCases = [
  'media-image-layout', 'media-image-selection', 'media-image-failure', 'media-diagram-selection',
  'media-diagram-layout', 'media-diagram-error', 'media-viewer', 'media-viewer-long',
  'media-viewer-diagram', 'media-export-controls', 'media-app-close',
] as const;
export type MediaCase = typeof mediaCases[number];
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(test: () => unknown) {
  const end = performance.now() + 25000;
  while (!test()) { check(performance.now() < end, 'Media regression timed out'); await new Promise(requestAnimationFrame); }
}
const image = (w: number, h: number) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="teal"/></svg>`);
export async function runMediaRegression(testCase: MediaCase): Promise<string> {
  if (testCase === 'media-app-close') {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); root.render(<App />);
    const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
    try {
      await until(() => document.querySelector('button[title="新建文档 (Ctrl+N)"]'));
      click('button[title="新建文档 (Ctrl+N)"]'); await until(() => document.querySelector('.newfile-card')); click('.newfile-card');
      await until(() => document.querySelector('.ProseMirror'));
      click('button[aria-label="切换源码模式"]'); await until(() => document.querySelector('.source-textarea'));
      const input = document.querySelector<HTMLTextAreaElement>('.source-textarea')!;
      const draft = `![preview](${image(100, 60)})\n`;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, draft);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(requestAnimationFrame);
      click('button[aria-label="返回编辑模式"]');
      await until(() => document.querySelector<HTMLButtonElement>('.md-media-controls button')?.disabled === false);
      click('.md-media-controls button'); await until(() => document.querySelector('.media-viewer[open]'));
      document.querySelector('.media-viewer')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
      check(!document.querySelector('.newfile-card'), 'Viewer shortcut edited background document');
      // This calls the same close handler as a native window-close request.
      click('button[aria-label="关闭窗口"]');
      await until(() => !document.querySelector('.media-viewer') && document.querySelector('#close-document-title'));
      check(input.value === draft, 'Window close from viewer lost draft');
      return `${testCase}: native close path dismisses viewer before unsaved confirmation`;
    } finally { root.unmount(); host.remove(); }
  }
  const host = document.createElement('div');
  host.className = 'editor-tab active'; host.style.cssText = 'height:600px;width:700px';
  const scroller = document.createElement('div'); scroller.className = 'milkdown-container'; host.append(scroller);
  const modal = document.createElement('div'); host.append(modal);
  document.body.append(host);
  const react = createRoot(modal);
  let selected: MediaPreview | undefined;
  const preview = (media: MediaPreview) => { selected = media; react.render(<MediaViewer media={media} onClose={() => react.render(null)} />); };
  const diagram = testCase.includes('diagram');
  const content = diagram ? `\`\`\`mermaid\ngraph LR\nA[中文起点]-->B[English endpoint]\n\`\`\`\n\nAfter`
    : `![small](${image(100, 60)})\n![](${image(1800, 400)})\n\n![](${image(160, testCase === 'media-viewer-long' ? 20000 : 2400)})\n\nBefore ![inline](${image(24, 18)}) after`;
  const editor = createEditor(scroller, content, { onUpdate: () => {}, onMediaPreview: preview });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const before = getCurrentState(editor).markdown;
  try {
    if (diagram) await until(() => scroller.querySelector('.md-mermaid-preview img') && !scroller.querySelector('.loading'));
    else await until(() => [...scroller.querySelectorAll('img:not(.ProseMirror-separator)')].every((img) => (img as HTMLImageElement).naturalWidth > 0)
      && [...scroller.querySelectorAll<HTMLButtonElement>('.md-media-controls button')].every((button) => !button.disabled));
    if (testCase === 'media-image-layout') {
      const imgs = [...scroller.querySelectorAll<HTMLImageElement>('img:not(.ProseMirror-separator)')];
      for (const width of [700, 400]) {
        host.style.width = `${width}px`;
        for (const zoom of [1, 1.2, 2]) {
          host.style.setProperty('--editor-zoom', String(zoom));
          for (const [index, naturalWidth, naturalHeight] of [[0, 100, 60], [1, 1800, 400], [2, 160, 2400]]) {
            const r = imgs[index].getBoundingClientRect(), p = imgs[index].closest('p')!.getBoundingClientRect();
            check(Math.abs(r.width / r.height - naturalWidth / naturalHeight) < 0.01, 'Image aspect ratio changed');
            check(r.width <= naturalWidth * zoom + 1 && r.width <= p.width + 1, 'Image stretched or overflowed');
            check(Math.abs(r.left + r.width / 2 - p.left - p.width / 2) < 1, 'Image is not centered');
          }
          check(imgs[1].getBoundingClientRect().top >= imgs[0].getBoundingClientRect().bottom, 'Adjacent images overlap');
          check(getComputedStyle(imgs[3].parentElement!).display === 'inline-block', 'Inline image no longer inline');
        }
      }
    } else if (testCase === 'media-image-failure') {
      const img = scroller.querySelector('.md-image-node img')!;
      img.dispatchEvent(new Event('error'));
      check(!img.parentElement!.querySelector<HTMLElement>('.md-image-error')!.hidden, 'Missing image error hidden');
      check(img.parentElement!.querySelector('button')!.disabled, 'Broken image can open preview');
      img.dispatchEvent(new Event('load'));
      check(img.parentElement!.querySelector<HTMLElement>('.md-image-error')!.hidden, 'Loaded image retains error');
    } else if (testCase === 'media-image-selection' || testCase === 'media-diagram-selection') {
      scroller.querySelector<HTMLElement>(diagram ? '.md-mermaid-holder' : '.md-image-node img')!.click();
      check(view.state.selection instanceof NodeSelection, 'Single click did not select node');
      check(!scroller.querySelector('textarea') && !document.querySelector('.media-viewer'), 'Single click entered editing or viewer');
      const copied = view.serializeForClipboard(view.state.selection.content());
      check(diagram ? copied.text.includes('graph LR') : copied.dom.querySelector('img')?.alt === 'small',
        'Selected media missing from clipboard serialization');
      view.dispatch(view.state.tr.deleteSelection());
      check(getCurrentState(editor).markdown !== before, 'Selected media could not be deleted');
      undo(editor);
      check(getCurrentState(editor).markdown === before, 'Undo did not restore media');
    } else if (testCase === 'media-diagram-layout') {
      const frame = scroller.querySelector<HTMLImageElement>('.md-mermaid-preview img')!;
      const html = new TextDecoder().decode(Uint8Array.from(atob(frame.src.split(',')[1]), (char) => char.charCodeAt(0)));
      const data = diagramPreview(html, '');
      for (const width of [700, 350]) {
        host.style.width = `${width}px`;
        const r = frame.getBoundingClientRect();
        check(r.width <= data.width + 1, 'Narrow diagram was stretched');
        check(Math.abs(r.width / r.height - data.width / data.height) < 0.02, 'Diagram image was clipped');
        check(frame.src.startsWith('data:image/svg+xml') && frame.naturalWidth > 0, 'Diagram is not a decoded inert SVG image');
        check(!scroller.querySelector('svg, iframe'), 'Active diagram markup leaked into editor');
        const holder = frame.closest('.md-mermaid-holder')!.getBoundingClientRect();
        check(Math.abs(r.left + r.width / 2 - holder.left - holder.width / 2) < 1, 'Diagram off center');
      }
    } else if (testCase === 'media-diagram-error') {
      scroller.querySelector<HTMLButtonElement>('.md-mermaid-edit')!.click();
      const textarea = scroller.querySelector<HTMLTextAreaElement>('textarea')!;
      check(document.activeElement === textarea, 'Explicit editing did not focus source');
      textarea.value = 'not valid diagram syntax';
      scroller.querySelector<HTMLButtonElement>('.md-mermaid-commit')!.click();
      await until(() => scroller.querySelector('.md-mermaid-error'));
      check(view.state.doc.firstChild!.textContent === textarea.value, 'Invalid source lost');
      scroller.querySelector<HTMLButtonElement>('.md-mermaid-edit')!.click();
      check(scroller.querySelector<HTMLTextAreaElement>('textarea')!.value === textarea.value, 'Invalid source cannot be corrected');
    } else if (testCase.startsWith('media-viewer')) {
      const long = testCase === 'media-viewer-long';
      const img = scroller.querySelector<HTMLImageElement>('.md-image-node img')!;
      if (diagram) scroller.querySelector<HTMLElement>('.md-mermaid-holder')!.click();
      else (long ? scroller.querySelectorAll<HTMLImageElement>('.md-image-node img')[2] : img).click();
      scroller.scrollTop = 0;
      const selection = view.state.selection.toJSON();
      if (diagram) scroller.querySelector<HTMLButtonElement>('.md-mermaid-enlarge')!.click();
      else scroller.querySelectorAll<HTMLButtonElement>('.md-media-controls button')[long ? 2 : 0].click();
      await until(() => document.querySelector('.media-viewer[open]'));
      if (diagram) {
        const image = document.querySelector<HTMLImageElement>('.media-viewer img')!;
        await image.decode();
        check(image.src.startsWith('data:image/svg+xml') && !document.querySelector('.media-viewer-content iframe, .media-viewer-content svg'), 'Viewer stopped using inert SVG image mode');
      } else if (long) {
        const area = document.querySelector<HTMLElement>('.media-viewer-viewport')!;
        await until(() => document.querySelector('.media-viewer-content')!.getBoundingClientRect().height <= area.clientHeight);
        const fitted = document.querySelector('output')!.textContent;
        document.querySelector('.media-viewer')!.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true, cancelable: true }));
        await new Promise(requestAnimationFrame);
        check(document.querySelector('output')!.textContent === fitted, 'Minus enlarged an image fitted below the manual zoom minimum');
        [...document.querySelectorAll<HTMLButtonElement>('.media-viewer button')].find((b) => b.textContent === '原始大小')!.click();
        await until(() => area.scrollHeight >= 2400);
        area.scrollTop = 700;
        check(area.scrollTop === 700, 'Original long image cannot scroll');
      } else {
        check(selected?.width === 100 && selected.height === 60, 'Viewer did not retain original image dimensions');
        check(document.querySelector('output')!.textContent === '100%', 'Viewer enlarges narrow image on open');
        document.querySelector<HTMLButtonElement>('button[aria-label="放大预览"]')!.click();
        await until(() => document.querySelector('output')!.textContent === '125%');
      }
      document.querySelector('.media-viewer')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await until(() => !document.querySelector('.media-viewer'));
      check(JSON.stringify(view.state.selection.toJSON()) === JSON.stringify(selection) && scroller.scrollTop === 0, 'Viewer moved document selection/scroll');
    } else {
      const html = await buildExport(captureExport(editor, before, 'media', 'misans', 'jetbrains-sarasa', (src) => src));
      const doc = new DOMParser().parseFromString(html, 'text/html');
      check(!doc.querySelector('.md-media-controls, .md-image-node'), 'Editing controls leaked into export');
      check(html.includes('data:image/svg+xml'), 'Export lost images');
    }
    if (!testCase.includes('error') && !testCase.endsWith('selection')) check(getCurrentState(editor).markdown === before, 'Viewing changed Markdown');
    return `${testCase}: passed (real Milkdown node selection, browser geometry and React viewer)`;
  } finally { react.unmount(); await editor.destroy(); host.remove(); }
}
