import { createRoot } from 'react-dom/client';
import { createNativeMocks } from './nativeMocks';
import { Editor, editorViewCtx } from '@milkdown/kit/core';
import { NodeSelection, TextSelection } from '@milkdown/prose/state';
import { createEditor, getCurrentState, undo } from '../../src/lib/editor';
import { MediaViewer } from '../../src/components/MediaViewer';
import { diagramPreview, type MediaPreview } from '../../src/lib/media';
import { ImageSelection } from '../../src/lib/imageSelection';
import { Presence } from '../../src/lib/presence';
import { captureExport, buildExport } from '../../src/lib/export';
import App from '../../src/App';
import '../../src/styles/global.css';

export const mediaCases = [
  'media-image-layout',
  'media-image-selection',
  'media-image-multiselect',
  'media-image-shift-select',
  'media-image-drag',
  'media-image-drag-reverse',
  'media-image-double-click',
  'media-image-marquee',
  'media-image-marquee-reverse',
  'media-image-marquee-zoom',
  'media-image-marquee-scroll',
  'media-image-marquee-cancel',
  'media-image-marquee-hidden',
  'media-image-text-drag',
  'media-image-failure',
  'media-diagram-selection',
  'media-diagram-layout',
  'media-diagram-error',
  'media-viewer',
  'media-viewer-long',
  'media-viewer-diagram',
  'media-viewer-controls',
  'media-viewer-close-frame',
  'media-viewer-close-queued',
  'media-viewer-rapid-reopen',
  'media-export-controls',
  'media-app-close',
  'media-app-marquee',
] as const;
export type MediaCase = (typeof mediaCases)[number];
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(test: () => unknown) {
  const end = performance.now() + 25000;
  while (!test()) {
    check(performance.now() < end, 'Media regression timed out');
    await new Promise(requestAnimationFrame);
  }
}
const image = (w: number, h: number) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="teal"/></svg>`,
  );
export async function runMediaRegression(testCase: MediaCase): Promise<string> {
  createNativeMocks().install();
  if (testCase === 'media-app-marquee') {
    const path = 'C:/synthetic-marquee.md';
    const markdown =
      '# Native-style marquee\n\n' +
      Array.from(
        { length: 2 },
        (_, i) =>
          `![left-${i}](${image(80, 64)}) KEEP-ROW-${i}-TEXT ![right-${i}](${image(80, 64)})\n\n`,
      ).join('');
    const defaults = createNativeMocks();
    createNativeMocks({
      fallback(command, args) {
        if (command === 'take_startup_files') return [path];
        if (command === 'read_document' || command === 'document_revision')
          return { path: args.path, content: markdown, revision: 'synthetic:initial', mtime: 1 };
        return defaults.invoke(command, args);
      },
    }).install();
    const make = Editor.make;
    let activeEditor: Editor | undefined;
    Editor.make = () => {
      activeEditor = make();
      return activeEditor;
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    root.render(<App />);
    try {
      await until(
        () =>
          activeEditor &&
          document.querySelectorAll('.editor-tab.active .md-image-node > img').length === 4,
      );
      const view = activeEditor!.action((ctx) => ctx.get(editorViewCtx));
      const images = [
        ...document.querySelectorAll<HTMLImageElement>('.editor-tab.active .md-image-node > img'),
      ];
      await until(() => images.every((img) => img.naturalWidth > 0));
      const first = images[0].getBoundingClientRect(),
        last = images[2].getBoundingClientRect();
      const drag = {
        ready: true,
        from: { x: first.left - 8, y: first.top - 8 },
        to: { x: first.right + 8, y: last.bottom + 8 },
        done: false,
      };
      Object.assign(window, { mdplusDrag: drag });
      await until(() => drag.done);
      check(
        view.state.selection instanceof ImageSelection &&
          view.state.selection.positions.length === 2,
        'Real App and React editor did not initialize rectangular image selection',
      );
      check(
        !view.serializeForClipboard(view.state.selection.content()).text.includes('KEEP-ROW'),
        'Real App marquee copied intervening text',
      );
      return `${testCase}: real App, React editor lifecycle and separate image ranges passed`;
    } finally {
      root.unmount();
      host.remove();
      Editor.make = make;
    }
  }
  if (testCase === 'media-app-close') {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    root.render(<App />);
    const click = (selector: string) =>
      document.querySelector<HTMLButtonElement>(selector)!.click();
    try {
      await until(() => document.querySelector('button[title="新建文档 (Ctrl+N)"]'));
      click('button[title="新建文档 (Ctrl+N)"]');
      await until(() => document.querySelector('.newfile-card'));
      click('.newfile-card');
      await until(() => document.querySelector('.ProseMirror'));
      click('button[aria-label="切换源码模式"]');
      await until(() => document.querySelector('.source-textarea'));
      const input = document.querySelector<HTMLTextAreaElement>('.source-textarea')!;
      const draft = `![preview](${image(100, 60)})\n`;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        draft,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(requestAnimationFrame);
      click('button[aria-label="返回编辑模式"]');
      await until(
        () =>
          document.querySelector<HTMLButtonElement>('.md-media-controls button')?.disabled ===
          false,
      );
      click('.md-media-controls button');
      await until(() => document.querySelector('.media-viewer[open]'));
      document.querySelector('.media-viewer')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'n',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise(requestAnimationFrame);
      const newFile = document.querySelector('.newfile-card');
      check(
        !newFile || newFile.closest('[inert]'),
        'Viewer shortcut opened an interactive background dialog',
      );
      // This calls the same close handler as a native window-close request.
      click('button[aria-label="关闭窗口"]');
      await until(
        () =>
          !document.querySelector('.media-viewer') &&
          document.querySelector('#close-document-title'),
      );
      check(
        document
          .querySelector('#close-document-title')!
          .closest('.modal')!
          .contains(document.activeElement),
        'Viewer exit stole the unsaved confirmation focus',
      );
      check(input.value === draft, 'Window close from viewer lost draft');
      return `${testCase}: native close path dismisses viewer before unsaved confirmation`;
    } finally {
      root.unmount();
      host.remove();
    }
  }
  const host = document.createElement('div');
  host.className = 'editor-tab active';
  host.style.cssText = 'height:600px;width:700px';
  const scroller = document.createElement('div');
  scroller.className = 'milkdown-container';
  host.append(scroller);
  const modal = document.createElement('div');
  host.append(modal);
  document.body.append(host);
  const react = createRoot(modal);
  let selected: MediaPreview | undefined;
  let previewCalls = 0;
  const renderPreview = (media?: MediaPreview) =>
    react.render(
      <Presence present={Boolean(media)}>
        {media && <MediaViewer media={media} onClose={() => renderPreview()} />}
      </Presence>,
    );
  const preview = (media: MediaPreview) => {
    previewCalls++;
    selected = media;
    renderPreview(media);
  };
  const diagram = testCase.includes('diagram');
  const marquee = testCase.includes('marquee') || testCase === 'media-image-text-drag';
  const content = marquee
    ? '# Marquee\n\n' +
      Array.from(
        { length: testCase.endsWith('scroll') ? 18 : 2 },
        (_, i) =>
          `![left-${i}](${image(80, 64)}) KEEP-ROW-${i}-TEXT ![right-${i}](${image(80, 64)})\n\n`,
      ).join('')
    : diagram
      ? `\`\`\`mermaid\ngraph LR\nA[中文起点]-->B[English endpoint]\n\`\`\`\n\nAfter`
      : `![small](${image(100, 60)})\n![](${image(1800, 400)})\n\n![](${image(160, testCase === 'media-viewer-long' ? 20000 : 2400)})\n\nBefore ![inline](${image(24, 18)}) after`;
  const editor = createEditor(scroller, content, { onUpdate: () => {}, onMediaPreview: preview });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const before = getCurrentState(editor).markdown;
  try {
    if (diagram)
      await until(
        () =>
          scroller.querySelector('.md-mermaid-preview img') && !scroller.querySelector('.loading'),
      );
    else
      await until(
        () =>
          [...scroller.querySelectorAll('img:not(.ProseMirror-separator)')].every(
            (img) => (img as HTMLImageElement).naturalWidth > 0,
          ) &&
          [...scroller.querySelectorAll<HTMLButtonElement>('.md-media-controls button')].every(
            (button) => !button.disabled,
          ),
      );
    if (marquee) {
      if (testCase.endsWith('zoom')) {
        host.style.setProperty('--editor-zoom', '1.6');
        await new Promise(requestAnimationFrame);
      }
      const images = [...scroller.querySelectorAll<HTMLImageElement>('.md-image-node > img')];
      const positions: number[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image') positions.push(pos);
      });
      if (testCase.endsWith('cancel') || testCase.endsWith('hidden')) images[1].click();
      const originalSelection = JSON.stringify(view.state.selection.toJSON());
      const nextTab = document.createElement('button');
      if (testCase.endsWith('hidden')) {
        nextTab.textContent = 'Other tab';
        document.body.append(nextTab);
      }
      const first = images[0].getBoundingClientRect(),
        last = images[2].getBoundingClientRect();
      const bounds = scroller.getBoundingClientRect();
      const reverse = testCase.endsWith('reverse');
      let from = { x: first.left - 8, y: first.top - 8 };
      let to = {
        x: first.right + 8,
        y: testCase.endsWith('scroll') ? bounds.bottom - 8 : last.bottom + 8,
      };
      if (reverse) [from, to] = [to, from];
      if (testCase === 'media-image-text-drag') {
        const text = [...images[0].closest('p')!.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE,
        )!;
        const range = document.createRange();
        range.setStart(text, 2);
        range.setEnd(text, 3);
        const a = range.getBoundingClientRect();
        range.setStart(text, 12);
        range.setEnd(text, 13);
        const b = range.getBoundingClientRect();
        from = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
        to = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      const drag = {
        ready: true,
        from,
        to,
        done: false,
        cancel: testCase.endsWith('cancel'),
        midway: { rectangle: false, masks: 0, clipped: false, scroll: 0 },
        capture() {
          const rectangle = document.querySelector('.md-image-marquee')?.getBoundingClientRect();
          drag.midway = {
            rectangle: Boolean(rectangle?.width && rectangle.height),
            masks: scroller.querySelectorAll('.md-image-selected').length,
            clipped: Boolean(
              rectangle &&
              rectangle.top >= bounds.top - 1 &&
              rectangle.bottom <= bounds.bottom + 1 &&
              rectangle.left >= bounds.left - 1 &&
              rectangle.right <= bounds.right + 1,
            ),
            scroll: scroller.scrollTop,
          };
          if (testCase.endsWith('hidden')) {
            host.setAttribute('inert', '');
            nextTab.focus();
          }
        },
      };
      Object.assign(window, { mdplusDrag: drag });
      await until(() => drag.done);
      await new Promise(requestAnimationFrame);
      check(
        !document.querySelector('.md-image-marquee'),
        'The marquee survived mouse release or cancellation',
      );
      if (testCase === 'media-image-text-drag') {
        check(
          view.state.selection instanceof TextSelection &&
            !view.state.selection.empty &&
            !drag.midway.rectangle &&
            !scroller.querySelector('.md-image-selected'),
          'Marquee intercepted native text selection',
        );
        return `${testCase}: native text drag and document content preserved`;
      }
      check(
        drag.midway.rectangle && drag.midway.clipped && drag.midway.masks >= 2,
        `Missing real drag rectangle or image masks: ${JSON.stringify(drag.midway)}`,
      );
      if (testCase.endsWith('cancel') || testCase.endsWith('hidden')) {
        check(
          JSON.stringify(view.state.selection.toJSON()) === originalSelection,
          'Canceling the marquee did not restore the previous selection',
        );
        if (testCase.endsWith('hidden')) {
          check(document.activeElement === nextTab, 'Hidden editor stole focus after mouseup');
          nextTab.remove();
        }
        return `${testCase}: real marquee canceled without document changes`;
      }
      check(
        view.state.selection instanceof ImageSelection,
        'Marquee did not create separate image ranges',
      );
      const selectedPositions = view.state.selection.positions;
      check(
        view.dom.classList.contains('ProseMirror-hideselection') &&
          getComputedStyle(images[0].closest('p')!, '::selection').backgroundColor ===
            'rgba(0, 0, 0, 0)',
        'Marquee still highlights the native text range between the selected images',
      );
      check(
        selectedPositions.every((pos) => positions.indexOf(pos) % 2 === 0),
        'Marquee selected an image outside its horizontal bounds',
      );
      if (testCase.endsWith('scroll'))
        check(
          drag.midway.scroll > 0 && selectedPositions.length > 2,
          'Marquee did not follow scrolling',
        );
      else
        check(
          selectedPositions.length === 2 &&
            selectedPositions[0] === positions[0] &&
            selectedPositions[1] === positions[2],
          'Marquee selected the intervening image instead of the intersecting images',
        );
      const clipboard = view.serializeForClipboard(view.state.selection.content());
      check(
        clipboard.dom.querySelectorAll('img').length === selectedPositions.length &&
          !clipboard.dom.textContent?.includes('KEEP-ROW') &&
          !clipboard.dom.querySelector('.md-media-controls'),
        'Marquee copy included text, unselected images or controls',
      );
      const text = view.state.doc.textContent;
      view.dispatch(view.state.tr.deleteSelection());
      check(
        view.state.doc.textContent === text &&
          scroller.querySelectorAll('.md-image-node').length ===
            images.length - selectedPositions.length,
        'Marquee deletion removed unselected content',
      );
      undo(editor);
      check(
        getCurrentState(editor).markdown === before &&
          view.state.selection instanceof ImageSelection,
        'Marquee undo did not restore the document and image selection',
      );
    } else if (testCase === 'media-image-layout') {
      const imgs = [
        ...scroller.querySelectorAll<HTMLImageElement>('img:not(.ProseMirror-separator)'),
      ];
      for (const width of [700, 400]) {
        host.style.width = `${width}px`;
        for (const zoom of [1, 1.2, 2]) {
          host.style.setProperty('--editor-zoom', String(zoom));
          for (const [index, naturalWidth, naturalHeight] of [
            [0, 100, 60],
            [1, 1800, 400],
            [2, 160, 2400],
          ]) {
            const r = imgs[index].getBoundingClientRect(),
              p = imgs[index].closest('p')!.getBoundingClientRect();
            check(
              Math.abs(r.width / r.height - naturalWidth / naturalHeight) < 0.01,
              'Image aspect ratio changed',
            );
            check(
              r.width <= naturalWidth * zoom + 1 && r.width <= p.width + 1,
              'Image stretched or overflowed',
            );
            check(
              Math.abs(r.left + r.width / 2 - p.left - p.width / 2) < 1,
              'Image is not centered',
            );
          }
          check(
            imgs[1].getBoundingClientRect().top >= imgs[0].getBoundingClientRect().bottom,
            'Adjacent images overlap',
          );
          check(
            getComputedStyle(imgs[3].parentElement!).display === 'inline-block',
            'Inline image no longer inline',
          );
        }
      }
    } else if (testCase === 'media-image-failure') {
      const img = scroller.querySelector('.md-image-node img')!;
      img.dispatchEvent(new Event('error'));
      check(
        !img.parentElement!.querySelector<HTMLElement>('.md-image-error')!.hidden,
        'Missing image error hidden',
      );
      check(img.parentElement!.querySelector('button')!.disabled, 'Broken image can open preview');
      img.dispatchEvent(new Event('load'));
      check(
        img.parentElement!.querySelector<HTMLElement>('.md-image-error')!.hidden,
        'Loaded image retains error',
      );
    } else if (testCase === 'media-image-selection' || testCase === 'media-diagram-selection') {
      scroller
        .querySelector<HTMLElement>(diagram ? '.md-mermaid-holder' : '.md-image-node img')!
        .click();
      check(view.state.selection instanceof NodeSelection, 'Single click did not select node');
      if (!diagram) {
        const node = scroller.querySelector<HTMLElement>('.md-image-node')!;
        const mask = getComputedStyle(node, '::after');
        check(
          node.classList.contains('ProseMirror-selectednode') &&
            mask.content !== 'none' &&
            parseFloat(mask.borderWidth) >= 2 &&
            mask.backgroundColor !== 'rgba(0, 0, 0, 0)',
          'Image selection lacks its translucent mask',
        );
        check(!node.textContent?.includes('已选中图片'), 'Selection still displays a text badge');
        scroller.querySelectorAll<HTMLImageElement>('.md-image-node > img')[1].click();
        check(
          getComputedStyle(node, '::after').content === 'none',
          'Previous image retains its selection mask',
        );
        node.querySelector('img')!.click();
      }
      check(
        !scroller.querySelector('textarea') && !document.querySelector('.media-viewer'),
        'Single click entered editing or viewer',
      );
      const copied = view.serializeForClipboard(view.state.selection.content());
      check(
        diagram
          ? copied.text.includes('graph LR')
          : copied.dom.querySelector('img')?.alt === 'small',
        'Selected media missing from clipboard serialization',
      );
      view.dispatch(view.state.tr.deleteSelection());
      check(getCurrentState(editor).markdown !== before, 'Selected media could not be deleted');
      undo(editor);
      check(getCurrentState(editor).markdown === before, 'Undo did not restore media');
    } else if (testCase === 'media-image-double-click') {
      const img = scroller.querySelector<HTMLImageElement>('.md-image-node img')!;
      img.click();
      check(previewCalls === 0, 'Single click opened the viewer');
      const selection = view.state.selection.toJSON();
      img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await until(() => document.querySelector('.media-viewer[open]'));
      check(
        Number(previewCalls) === 1 && selected?.kind === 'image' && selected.width === 100,
        'Double click did not open exactly one original image preview',
      );
      document.querySelector<HTMLButtonElement>('button[aria-label="关闭查看器"]')!.click();
      await until(() => !document.querySelector('.media-viewer'));
      check(
        JSON.stringify(view.state.selection.toJSON()) === JSON.stringify(selection),
        'Preview changed the editor selection',
      );
      img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, ctrlKey: true }));
      img.dispatchEvent(new Event('error'));
      img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      check(
        Number(previewCalls) === 1 && getCurrentState(editor).markdown === before,
        'Modified or broken-image double click opened a preview or changed the document',
      );
    } else if (
      testCase.startsWith('media-image-drag') ||
      testCase === 'media-image-multiselect' ||
      testCase === 'media-image-shift-select'
    ) {
      const images = [...scroller.querySelectorAll<HTMLImageElement>('.md-image-node > img')];
      const positions: number[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image') positions.push(pos);
      });
      if (testCase.startsWith('media-image-drag')) {
        const reverse = testCase === 'media-image-drag-reverse';
        const a = images[reverse ? 1 : 0].getBoundingClientRect();
        const b = images[reverse ? 0 : 1].getBoundingClientRect();
        Object.assign(window, {
          mdplusDrag: {
            ready: true,
            from: { x: a.left + a.width / 2, y: a.top + a.height / 2 },
            to: { x: b.left + b.width / 2, y: b.top + b.height / 2 },
            done: false,
          },
        });
        await until(() => (window as unknown as { mdplusDrag: { done: boolean } }).mdplusDrag.done);
        await new Promise(requestAnimationFrame);
      } else if (testCase === 'media-image-shift-select') {
        images[1].click();
        const rect = images[0].getBoundingClientRect();
        images[0].dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            shiftKey: true,
            clientX: rect.left + 1,
            clientY: rect.top + 1,
          }),
        );
        images[0].dispatchEvent(new MouseEvent('mouseup', { bubbles: true, shiftKey: true }));
        images[0].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      } else
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, positions[0], positions[1] + 1),
          ),
        );
      check(
        view.state.selection instanceof TextSelection &&
          view.state.selection.from === positions[0] &&
          view.state.selection.to === positions[1] + 1,
        `Range does not cover both images: ${JSON.stringify(view.state.selection.toJSON())}`,
      );
      check(
        scroller.querySelectorAll('.md-image-selected').length === 2,
        'Range does not mask all and only the selected images',
      );
      for (const img of images.slice(0, 2))
        check(
          getComputedStyle(img.parentElement!, '::after').content !== 'none',
          'Selected image is missing its mask',
        );
      const clipboard = view.serializeForClipboard(view.state.selection.content());
      check(
        clipboard.dom.querySelectorAll('img').length === 2 &&
          !clipboard.dom.querySelector('.md-media-controls'),
        'Multi-image clipboard lost media or copied the controls',
      );
      view.dispatch(view.state.tr.deleteSelection());
      check(
        scroller.querySelectorAll('.md-image-node').length === images.length - 2,
        'Delete did not remove the entire image range',
      );
      undo(editor);
      check(
        getCurrentState(editor).markdown === before,
        'Undo did not restore the entire image range',
      );
    } else if (testCase === 'media-diagram-layout') {
      const frame = scroller.querySelector<HTMLImageElement>('.md-mermaid-preview img')!;
      const html = new TextDecoder().decode(
        Uint8Array.from(atob(frame.src.split(',')[1]), (char) => char.charCodeAt(0)),
      );
      const data = diagramPreview(html, '');
      for (const width of [700, 350]) {
        host.style.width = `${width}px`;
        const r = frame.getBoundingClientRect();
        check(r.width <= data.width + 1, 'Narrow diagram was stretched');
        check(
          Math.abs(r.width / r.height - data.width / data.height) < 0.02,
          'Diagram image was clipped',
        );
        check(
          frame.src.startsWith('data:image/svg+xml') && frame.naturalWidth > 0,
          'Diagram is not a decoded inert SVG image',
        );
        check(!scroller.querySelector('svg, iframe'), 'Active diagram markup leaked into editor');
        const holder = frame.closest('.md-mermaid-holder')!.getBoundingClientRect();
        check(
          Math.abs(r.left + r.width / 2 - holder.left - holder.width / 2) < 1,
          'Diagram off center',
        );
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
      check(
        scroller.querySelector<HTMLTextAreaElement>('textarea')!.value === textarea.value,
        'Invalid source cannot be corrected',
      );
    } else if (testCase.startsWith('media-viewer')) {
      const special = [
        'media-viewer-controls',
        'media-viewer-close-frame',
        'media-viewer-close-queued',
        'media-viewer-rapid-reopen',
      ].includes(testCase);
      const long = testCase === 'media-viewer-long' || special;
      const img = scroller.querySelector<HTMLImageElement>('.md-image-node img')!;
      if (diagram) scroller.querySelector<HTMLElement>('.md-mermaid-holder')!.click();
      else
        (long ? scroller.querySelectorAll<HTMLImageElement>('.md-image-node img')[2] : img).click();
      scroller.scrollTop = 0;
      const selection = view.state.selection.toJSON();
      const focus = document.activeElement;
      if (diagram) scroller.querySelector<HTMLButtonElement>('.md-mermaid-enlarge')!.click();
      else {
        const controls = scroller.querySelectorAll<HTMLButtonElement>('.md-media-controls button');
        controls[long ? 2 : 0].click();
      }
      await until(() => document.querySelector('.media-viewer[open]'));
      if (diagram) {
        const image = document.querySelector<HTMLImageElement>('.media-viewer img')!;
        await image.decode();
        check(
          image.src.startsWith('data:image/svg+xml') &&
            !document.querySelector('.media-viewer-content iframe, .media-viewer-content svg'),
          'Viewer stopped using inert SVG image mode',
        );
      } else if (special) {
        const dialog = document.querySelector<HTMLElement>('.media-viewer')!;
        const area = document.querySelector<HTMLElement>('.media-viewer-viewport')!;
        const output = () => document.querySelector('output')!.textContent;
        [...dialog.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '原始大小')!
          .click();
        await until(() => output() === '100%');
        area.scrollTop = 500;
        const rect = area.getBoundingClientRect(),
          point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const picture = dialog.querySelector<HTMLElement>('.media-viewer-content')!;
        const originalY = point.y - picture.getBoundingClientRect().top;
        const wheel = (delta: number, ctrlKey = true) => {
          const event = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            ctrlKey,
            deltaY: delta,
            clientX: point.x,
            clientY: point.y,
          });
          area.dispatchEvent(event);
          return event;
        };
        check(wheel(-40).defaultPrevented, 'Viewer did not consume Ctrl+wheel');
        await until(() => output() === '125%');
        check(
          Math.abs((point.y - picture.getBoundingClientRect().top) / 1.25 - originalY) < 2,
          'Viewer wheel lost the image point under the pointer',
        );
        if (testCase === 'media-viewer-controls') {
          check(!wheel(40, false).defaultPrevented, 'Viewer consumed ordinary scroll');
          for (let i = 0; i < 8; i++) wheel(-40);
          await until(() => output() === '400%');
          const key = (value: string, extra = {}) => {
            const event = new KeyboardEvent('keydown', {
              key: value,
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
              ...extra,
            });
            dialog.dispatchEvent(event);
            return event;
          };
          check(key('-').defaultPrevented, 'Ctrl+minus was not consumed');
          await until(() => output() === '320%');
          check(key('=').defaultPrevented, 'Ctrl+plus was not consumed');
          await until(() => output() === '400%');
          check(
            !key('+', { altKey: true }).defaultPrevented &&
              !key('+', { isComposing: true }).defaultPrevented,
            'Modified or composing key changed viewer zoom',
          );
          for (let i = 0; i < 30; i++) key('-');
          await until(() => output() === '10%');
          wheel(-40);
          [...dialog.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.textContent === '适合窗口')!
            .click();
          await new Promise(requestAnimationFrame);
          check(
            area.scrollTop === 0 &&
              dialog.querySelector('button[aria-pressed="true"]')?.textContent === '适合窗口',
            'Fit reset failed to cancel a queued zoom',
          );
        } else {
          if (testCase === 'media-viewer-close-queued') {
            wheel(-40);
            await new Promise(requestAnimationFrame);
          }
          const geometry = picture.getBoundingClientRect();
          const scroll = area.scrollTop;
          dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭查看器"]')!.click();
          await new Promise(requestAnimationFrame);
          check(
            !dialog.hasAttribute('open') && dialog.closest('[inert]') && picture.isConnected,
            'Exit lost its retained, inactive preview',
          );
          const exiting = picture.getBoundingClientRect();
          check(
            Math.abs(exiting.width - geometry.width) < 1 &&
              Math.abs(exiting.height - geometry.height) < 1 &&
              area.scrollTop === scroll,
            'Viewer exit reset image geometry or scrolling',
          );
          if (testCase === 'media-viewer-rapid-reopen') {
            scroller
              .querySelectorAll<HTMLImageElement>('.md-image-node > img')[2]
              .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
            await until(() => document.querySelector('.media-viewer[open]'));
            check(
              document.querySelectorAll('.media-viewer').length === 1 &&
                !document.querySelector('.media-viewer')!.closest('[inert]'),
              'Rapid reopening duplicated or disabled the viewer',
            );
          } else await until(() => !document.querySelector('.media-viewer'));
        }
      } else if (long) {
        const area = document.querySelector<HTMLElement>('.media-viewer-viewport')!;
        await until(
          () =>
            document.querySelector('.media-viewer-content')!.getBoundingClientRect().height <=
            area.clientHeight,
        );
        const fitted = document.querySelector('output')!.textContent;
        document
          .querySelector('.media-viewer')!
          .dispatchEvent(
            new KeyboardEvent('keydown', { key: '-', bubbles: true, cancelable: true }),
          );
        await new Promise(requestAnimationFrame);
        check(
          document.querySelector('output')!.textContent === fitted,
          'Minus enlarged an image fitted below the manual zoom minimum',
        );
        [...document.querySelectorAll<HTMLButtonElement>('.media-viewer button')]
          .find((b) => b.textContent === '原始大小')!
          .click();
        await until(() => area.scrollHeight >= 2400);
        area.scrollTop = 700;
        check(area.scrollTop === 700, 'Original long image cannot scroll');
      } else {
        check(
          selected?.width === 100 && selected.height === 60,
          'Viewer did not retain original image dimensions',
        );
        check(
          document.querySelector('output')!.textContent === '100%',
          'Viewer enlarges narrow image on open',
        );
        document.querySelector<HTMLButtonElement>('button[aria-label="放大预览"]')!.click();
        await until(() => document.querySelector('output')!.textContent === '125%');
      }
      document
        .querySelector('.media-viewer')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      await until(() => !document.querySelector('.media-viewer'));
      check(
        JSON.stringify(view.state.selection.toJSON()) === JSON.stringify(selection) &&
          scroller.scrollTop === 0,
        'Viewer moved document selection/scroll',
      );
      check(document.activeElement === focus, 'Viewer did not restore the editor focus');
    } else {
      const html = await buildExport(
        captureExport(editor, before, 'media', 'misans', 'jetbrains-sarasa', (src) => src),
      );
      const doc = new DOMParser().parseFromString(html, 'text/html');
      check(
        !doc.querySelector('.md-media-controls, .md-image-node'),
        'Editing controls leaked into export',
      );
      check(html.includes('data:image/svg+xml'), 'Export lost images');
    }
    if (!testCase.includes('error') && !testCase.endsWith('selection'))
      check(getCurrentState(editor).markdown === before, 'Viewing changed Markdown');
    return `${testCase}: passed (real Milkdown node selection, browser geometry and React viewer)`;
  } finally {
    react.unmount();
    await editor.destroy();
    host.remove();
  }
}
