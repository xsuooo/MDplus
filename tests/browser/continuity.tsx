import { createRoot } from 'react-dom/client';
import { createNativeMocks, decodeFixtureBase64, encodeFixtureBytes } from './nativeMocks';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection, NodeSelection } from '@milkdown/prose/state';
import { undoDepth } from '@milkdown/prose/history';
import { createEditor, getCurrentState, setMarkdown } from '../../src/lib/editor';
import App from '../../src/App';
import { toRendered, toSource } from '../../src/lib/editorPosition';
import { sourceTextLayout } from '../../src/lib/sourcePosition';
import '../../src/styles/global.css';

export const continuityCases = [
  'sync-identical',
  'sync-image-attributes',
  'sync-local-edit',
  'source-tab-history',
  'mode-reading-anchor',
  'mode-selection-roundtrip',
  'font-source-position',
  'font-pending-restore',
  'font-pending-input',
  'font-pending-wheel',
  'font-pending-key',
  'font-pending-pointer',
  'font-pending-other-input',
  'font-pending-other-radio',
  'font-pending-radio-key',
  'rendered-tab-position',
  'mode-formatted-blocks',
  'mode-input-isolation',
  'mode-range-budget',
  'mode-source-data-uri',
  'zoom-live-view',
  'zoom-mode-switch',
] as const;
export type ContinuityCase = (typeof continuityCases)[number];
export const longDocument = Array.from(
  { length: 35 },
  (_, i) =>
    `## Section ${i}\n\n段落 ${i} 中文 Mixed English **bold** and \`code\`. ${'Long paragraph content. '.repeat(8)}\n`,
).join('\n');

function sourceImageUri(): string {
  const image = decodeFixtureBase64('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoIAAgAAUAmJaQAA3AA/vz0AAA=');
  const payload = new Uint8Array(116000);
  let random = 20261110;
  for (let index = 0; index < payload.length - 10536; index++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    payload[index] = random >>> 24;
  }
  // Valid synthetic WebP with ignored RIFF data; no user image or large checked-in fixture.
  payload.fill(255, payload.length - 10536);
  const bytes = new Uint8Array(image.length + 8 + payload.length);
  bytes.set(image);
  bytes.set([74, 85, 78, 75], image.length);
  const header = new DataView(bytes.buffer);
  header.setUint32(4, bytes.length - 8, true);
  header.setUint32(image.length + 4, payload.length, true);
  bytes.set(payload, image.length + 8);
  return 'data:image/webp;base64,' + encodeFixtureBytes(bytes);
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(condition: () => unknown) {
  const deadline = performance.now() + 10000;
  while (!condition()) {
    check(performance.now() < deadline, 'Continuity regression timed out');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  check(button, `Missing ${selector}`);
  button.click();
}
function input(field: HTMLTextAreaElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function runContinuityRegression(testCase: ContinuityCase): Promise<string> {
  createNativeMocks().install();
  if (testCase.startsWith('zoom-')) localStorage.setItem('mdplus-editor-zoom', '100');
  if (testCase === 'mode-source-data-uri') {
    const image = sourceImageUri();
    const markdown = `# Source layout\n\n![one](${image}) ![two](${image})\n\nKeep **selected marker** here.\n`;
    const host = document.createElement('div');
    host.className = 'milkdown-container';
    host.style.cssText = 'width:960px;height:420px;overflow:auto';
    const input = document.createElement('textarea');
    input.className = 'source-textarea';
    input.style.cssText = 'width:960px;height:420px;display:none';
    input.value = markdown;
    document.body.append(host, input);
    const editor = createEditor(host, markdown, {
      onUpdate: () => {},
      resolveImageIdentity: (url) => url,
      resolveImageReference: (url) => url,
    });
    await editor.create();
    try {
      await document.fonts.ready;
      await until(() => {
        const images = [...host.querySelectorAll<HTMLImageElement>('.md-image-node img')];
        return (
          images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0)
        );
      });
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      const original = view.state.doc;
      let at = -1;
      original.descendants((node, position) => {
        if (node.isText && node.text?.includes('selected marker'))
          at = position + node.text.indexOf('selected marker');
      });
      check(at >= 0, 'Long source fixture lost its selected text');
      view.dispatch(view.state.tr.setSelection(TextSelection.create(original, at + 15, at)));
      const start = performance.now();
      input.style.display = '';
      toSource(editor, markdown, input);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const elapsedMs = performance.now() - start;
      check(
        getComputedStyle(input).fontVariantLigatures === 'none',
        'Source ligatures remain enabled for long embedded-image data',
      );
      check(
        sourceTextLayout(input).properties['font-variant-ligatures'] === 'none',
        'Source measurement does not capture the disabled ligatures',
      );
      check(input.value === markdown, 'Source switching changed embedded image bytes');
      check(
        input.value.slice(input.selectionStart, input.selectionEnd) === 'selected marker' &&
          input.selectionDirection === 'backward',
        'Long source switching lost selected text or its direction',
      );
      toRendered(editor, markdown, input);
      check(
        view.state.doc === original &&
          view.state.doc.textBetween(view.state.selection.from, view.state.selection.to) ===
            'selected marker' &&
          view.state.selection.anchor > view.state.selection.head,
        'Long source round trip changed the document or selection',
      );
      return JSON.stringify({ case: testCase, characters: markdown.length, elapsedMs });
    } finally {
      await editor.destroy();
      host.remove();
      input.remove();
    }
  }
  if (testCase === 'mode-range-budget') {
    const host = document.createElement('div');
    host.className = 'milkdown-container';
    host.style.cssText = 'width:800px;height:420px';
    const input = document.createElement('textarea');
    input.className = 'source-textarea';
    input.style.cssText = 'width:800px;height:420px';
    const markdown = longDocument.repeat(8);
    input.value = markdown;
    document.body.append(host, input);
    const editor = createEditor(host, markdown, { onUpdate: () => {} });
    await editor.create();
    await document.fonts.ready;
    const original = Range.prototype.getBoundingClientRect;
    let reads = 0;
    Range.prototype.getBoundingClientRect = function () {
      reads++;
      return original.call(this);
    };
    try {
      toSource(editor, markdown, input);
      const at = markdown.indexOf('段落 17', markdown.length / 2);
      check(at > 0, 'Range budget fixture lacks its middle paragraph');
      input.setSelectionRange(at, at + 2);
      input.scrollTop = input.scrollHeight / 2;
      toRendered(editor, markdown, input);
      toSource(editor, markdown, input);
      check(
        input.value.slice(input.selectionStart, input.selectionEnd) === '段落',
        'Visible-block mapping lost the selected text',
      );
      check(reads < 100, `Mode switching measured the whole document: ${reads} Range reads`);
      return `${testCase}: ${reads} Range reads for 280 sections with selection preserved`;
    } finally {
      Range.prototype.getBoundingClientRect = original;
      await editor.destroy();
      host.remove();
      input.remove();
    }
  }
  if (testCase.startsWith('sync-')) {
    const host = document.createElement('div');
    host.className = 'milkdown-container';
    host.style.height = '420px';
    const search = document.createElement('input');
    document.body.append(host, search);
    const updates: string[] = [];
    const original = `![first](mdplus-image:one)\n\n${longDocument}\n\n![last](mdplus-image:two)`;
    const editor = createEditor(host, original, { onUpdate: (u) => updates.push(u.markdown) });
    await editor.create();
    try {
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      let pos = 0;
      view.state.doc.descendants((node, at) => {
        if (node.isText && node.text?.includes('段落 17')) pos = at + 5;
      });
      if (testCase === 'sync-image-attributes') {
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
      } else
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(view.state.doc, pos, pos + 8)),
        );
      const selection = view.state.selection.toJSON();
      const beforeDoc = view.state.doc;
      const beforeNode = host.querySelector('h2:nth-of-type(18)');
      const depth = undoDepth(view.state);
      host.scrollTop = 1600;
      const top = host.scrollTop;
      search.focus();
      const markdown =
        testCase === 'sync-image-attributes'
          ? original
              .replace('mdplus-image:one', './assets/first.png')
              .replace('mdplus-image:two', './assets/last.png')
          : testCase === 'sync-local-edit'
            ? original.replace('Section 0', 'Section Zero')
            : getCurrentState(editor).markdown;
      setMarkdown(editor, markdown);
      check(document.activeElement === search, 'Background sync stole focus');
      check(host.scrollTop === top, 'Background sync changed scroll position');
      check(
        host.querySelector('h2:nth-of-type(18)') === beforeNode,
        'Unchanged blocks were rebuilt',
      );
      if (testCase === 'sync-identical') {
        check(
          view.state.doc === beforeDoc && undoDepth(view.state) === depth,
          'Identical sync changed document/history',
        );
      } else if (testCase === 'sync-image-attributes') {
        check(
          JSON.stringify(view.state.selection.toJSON()) === JSON.stringify(selection),
          'Image migration changed node selection',
        );
      } else {
        check(
          view.state.selection.from === pos + 3 && view.state.selection.to === pos + 11,
          'Selection did not map across a preceding edit',
        );
      }
      return `${testCase}: focus, selection, scroll, unchanged nodes and no-op history passed`;
    } finally {
      await editor.destroy();
      host.remove();
      search.remove();
    }
  }

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(<App />);
  try {
    await until(() => document.querySelector('button[title="新建文档 (Ctrl+N)"]'));
    click('button[title="新建文档 (Ctrl+N)"]');
    await until(() => document.querySelector('.newfile-card'));
    click('.newfile-card');
    await until(() => document.querySelector('.ProseMirror'));
    click('button[aria-label="切换源码模式"]');
    await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'));
    let field = document.querySelector<HTMLTextAreaElement>(
      '.source-editor:not([hidden]) .source-textarea',
    )!;
    if (testCase === 'mode-input-isolation') {
      input(field, '```text\n题目内容\n```');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      click('button[aria-label="切换源码模式"]');
      await until(() => document.querySelector('.md-code-copy'));
      const rendered = document.querySelector<HTMLElement>('.editor-tab.active')!;
      const mirror = rendered.querySelector('.ProseMirror');
      const copy = rendered.querySelector<HTMLButtonElement>('.md-code-copy')!;
      const height = rendered.getBoundingClientRect().height;
      click('button[aria-label="切换源码模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden])'));
      check(
        rendered.inert && rendered.getAttribute('aria-hidden') === 'true',
        'Source mode leaves covered editor controls in the input/accessibility tree',
      );
      field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
      field.focus();
      copy.focus();
      check(document.activeElement === field, 'Keyboard focus entered a hidden copy button');
      check(
        rendered.getBoundingClientRect().height === height,
        'Input isolation changed rendered-editor geometry',
      );
      click('button[aria-label="切换源码模式"]');
      await until(() => !document.querySelector('.source-editor:not([hidden])'));
      check(
        !rendered.inert &&
          !rendered.hasAttribute('aria-hidden') &&
          rendered.querySelector('.ProseMirror') === mirror,
        'Mode change rebuilt or left the editor inaccessible',
      );
      copy.focus();
      check(
        document.activeElement === copy,
        'Copy button did not become accessible after returning to rendered mode',
      );
      return `${testCase}: source-mode focus isolation and editor identity/geometry passed`;
    }
    if (testCase === 'mode-formatted-blocks') {
      const fixtures = [
        [
          '## Same heading\n\nFirst paragraph\n\n## Same heading\n\nSecond **目标文字** with 中文🙂.',
          '目标文字',
        ],
        ['- outer\n  - nested **列表文本**\n  - other', '列表文本'],
        ['> 引用 **中间内容** 后文', '中间内容'],
        ['| A | B |\n|---|---|\n| 1 | 表格文本 |', '表格文本'],
        ['```ts\nconst greeting = "代码文本";\n```', '代码文本'],
        ['正文 $x^2$ 后面的中文🙂文本', '中文🙂'],
      ];
      for (const [markdown, selected] of fixtures) {
        input(field, markdown);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const at = markdown.indexOf(selected);
        field.setSelectionRange(at, at + selected.length);
        click('button[aria-label="切换源码模式"]');
        await until(() => !document.querySelector('.source-editor:not([hidden])'));
        check(
          window.getSelection()?.toString() === selected,
          `Lost selected text in structured block: ${selected} => ${window.getSelection()?.toString()}`,
        );
        click('button[aria-label="切换源码模式"]');
        await until(() => document.querySelector('.source-editor:not([hidden])'));
        field = document.querySelector<HTMLTextAreaElement>(
          '.source-editor:not([hidden]) textarea',
        )!;
        check(
          field.value.slice(field.selectionStart, field.selectionEnd) === selected,
          'Structured selection did not return to source',
        );
      }
      return `${testCase}: duplicate headings, lists, quote, table, code and inline-math text selections passed`;
    }
    input(field, longDocument);
    await until(() => field.value === longDocument);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (testCase.startsWith('zoom-')) {
      await document.fonts.ready;
      click('button[aria-label="切换源码模式"]');
      await until(() => !document.querySelector('.source-editor:not([hidden])'));
      const rich = document.querySelector<HTMLElement>('.editor-tab.active .milkdown')!;
      const editor = rich.querySelector<HTMLElement>('.ProseMirror')!;
      const doc = (editor as HTMLElement & { pmViewDesc?: { node: object } }).pmViewDesc!.node;
      const scroller = rich.closest<HTMLElement>('.milkdown-container')!;
      const heading = editor.querySelectorAll<HTMLHeadingElement>('h2')[17];
      scroller.scrollTop +=
        heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100;
      await new Promise(requestAnimationFrame);
      const rect = heading.getBoundingClientRect();
      const toolbar = document.querySelector('.toolbar')!.getBoundingClientRect().toJSON();
      for (let index = 0; index < 2; index++) {
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -40,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        });
        heading.dispatchEvent(event);
        check(event.defaultPrevented, 'Ctrlwheel escaped into page zoom');
      }
      await until(() => document.querySelector('.statusbar-zoom')?.textContent === '120%');
      check(
        rich.style.transform === 'scale(1.2)',
        'Continuous zoom did not use its lightweight preview',
      );
      if (testCase === 'zoom-mode-switch') {
        const mode = document.querySelector<HTMLButtonElement>(
          'button[aria-label="切换源码模式"]',
        )!;
        mode.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        check(
          rich.style.getPropertyValue('transform') === '' && rich.style.zoom === '1.2',
          'Mode interaction read unfinished zoom geometry',
        );
        mode.click();
        await until(() => document.querySelector('.source-editor:not([hidden]) textarea'));
        const source = document.querySelector<HTMLTextAreaElement>(
          '.source-editor:not([hidden]) textarea',
        )!;
        check(
          source.style.zoom === '1.2' && source.value === longDocument,
          'Source mode lost the zoom or source text',
        );
        source.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 40 }),
        );
        await until(() => document.querySelector('.statusbar-zoom')?.textContent === '110%');
        mode.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        mode.click();
        await until(() => !document.querySelector('.source-editor:not([hidden])'));
        check(
          rich.style.getPropertyValue('zoom') === '1.1' && !source.style.transform,
          'Returning to rich mode left a pending source preview',
        );
      } else {
        await until(() => !rich.style.transform && rich.style.zoom === '1.2');
        const after = heading.getBoundingClientRect();
        check(
          Math.abs(after.top + after.height / 2 - rect.top - rect.height / 2) < 2,
          'Zoom moved the paragraph under the pointer',
        );
      }
      check(
        (editor as HTMLElement & { pmViewDesc?: { node: object } }).pmViewDesc!.node === doc,
        'Zoom changed or recreated the document',
      );
      check(
        JSON.stringify(document.querySelector('.toolbar')!.getBoundingClientRect().toJSON()) ===
          JSON.stringify(toolbar),
        'Editor zoom changed the toolbar geometry',
      );
      return `${testCase}: coalesced preview, settled geometry, document identity and shared mode zoom passed`;
    }
    if (testCase.startsWith('font-pending-') || testCase === 'font-source-position')
      await document.fonts.ready;
    const selection = longDocument.indexOf('段落 17') + 5;
    field.setSelectionRange(selection, selection + 8, 'backward');
    field.dispatchEvent(new Event('select', { bubbles: true }));
    field.scrollTop = 1400;
    const sourceTop = field.scrollTop;
    if (testCase.startsWith('font-pending-')) {
      const snapshot = () => ({
        scrollTop: field.scrollTop,
        start: field.selectionStart,
        end: field.selectionEnd,
        direction: field.selectionDirection,
        text: field.value,
      });
      const expected = Object.freeze(snapshot());
      check(
        expected.scrollTop === 1400 &&
          expected.start === selection &&
          expected.end === selection + 8 &&
          expected.direction === 'backward' &&
          expected.text === longDocument,
        'Invalid pending-font source fixture',
      );
      click('button[aria-label="排版设置"]');
      await until(() => document.querySelector('.typography-panel'));
      const radio = document.querySelector<HTMLInputElement>(
        'input[name="code-font"]:not(:checked)',
      )!;
      const radioInputs: { type: string; trusted: boolean }[] = [];
      const sourceInputs: { type: string; trusted: boolean; inputType: string }[] = [];
      const observeInput = (event: Event) => {
        if (event.target === radio)
          radioInputs.push({ type: event.type, trusted: event.isTrusted });
        if (event.target === field)
          sourceInputs.push({
            type: event.type,
            trusted: event.isTrusted,
            inputType: event instanceof InputEvent ? event.inputType : '',
          });
      };
      const nativeLoad = document.fonts.load;
      const loads: Promise<FontFace[]>[] = [];
      const requests: { font: string; text?: string }[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      document.fonts.load = (font, text) => {
        const loaded = nativeLoad.call(document.fonts, font, text);
        loads.push(loaded);
        requests.push({ font, text });
        return loaded.then(
          async (faces) => {
            await gate;
            return faces;
          },
          async (error) => {
            await gate;
            throw error;
          },
        );
      };
      const sourceNavigation: { type: string; trusted: boolean }[] = [];
      const observeNavigation = (event: Event) => {
        if (event.target === field)
          sourceNavigation.push({ type: event.type, trusted: event.isTrusted });
      };
      for (const event of ['wheel', 'keydown', 'pointerdown'])
        window.addEventListener(event, observeNavigation, true);
      window.addEventListener('input', observeInput, true);
      try {
        radio.click();
        await until(() => loads.length > 0);
        const beforeAdjustment = snapshot();
        // Reproduce the observed 1px non-user font-layout offset; no input event or large jump is fabricated.
        if (testCase === 'font-pending-restore') field.scrollTop = expected.scrollTop - 1;
        const pending = snapshot();
        const faces = await Promise.all(loads);
        await document.fonts.ready;
        check(
          faces.every(
            (group) => group.length > 0 && group.every((face) => face.status === 'loaded'),
          ),
          'Pending-font test did not load the real bundled fonts',
        );
        let userPlace: ReturnType<typeof snapshot> | undefined;
        let boundaryAction:
          { type: string; name: string; event: string; trusted: boolean } | undefined;
        if (testCase === 'font-pending-input') {
          field.focus({ preventScroll: true });
          check(
            document.execCommand('insertText', false, '用户输入'),
            'Native source text insertion failed',
          );
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          userPlace = Object.freeze(snapshot());
          const edited =
            longDocument.slice(0, selection) + '用户输入' + longDocument.slice(selection + 8);
          check(
            userPlace.text === edited &&
              userPlace.start === selection + 4 &&
              userPlace.end === selection + 4 &&
              sourceInputs.some((event) => event.trusted && event.inputType === 'insertText'),
            'Source input was not a real user edit',
          );
        }
        if (testCase === 'font-pending-wheel') {
          const beforeWheel = field.scrollTop;
          field.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }),
          );
          // Synthetic wheel events have no browser default; apply the requested user scroll through the public DOM.
          field.scrollBy({ top: 240, behavior: 'instant' });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          userPlace = Object.freeze(snapshot());
          check(
            userPlace.scrollTop === beforeWheel + 240 &&
              userPlace.text === longDocument &&
              userPlace.start === selection &&
              userPlace.end === selection + 8 &&
              userPlace.direction === 'backward',
            'Source wheel fixture did not navigate by exactly 240px',
          );
        }
        if (testCase === 'font-pending-key') {
          field.focus({ preventScroll: true });
          field.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
          );
          // Apply ArrowRight's collapsed caret explicitly: a synthetic key event has no native default.
          field.setSelectionRange(selection + 8, selection + 8, 'forward');
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          userPlace = Object.freeze(snapshot());
          check(
            userPlace.text === longDocument &&
              userPlace.start === selection + 8 &&
              userPlace.end === selection + 8 &&
              userPlace.direction === 'forward',
            'Source key fixture did not move the caret',
          );
        }
        if (testCase === 'font-pending-pointer') {
          field.dispatchEvent(
            new PointerEvent('pointerdown', {
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
              button: 0,
              buttons: 1,
              bubbles: true,
              cancelable: true,
            }),
          );
          field.focus({ preventScroll: true });
          // Apply the newly chosen caret explicitly: a synthetic pointer event has no native default.
          field.setSelectionRange(selection + 2, selection + 2, 'forward');
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          userPlace = Object.freeze(snapshot());
          check(
            userPlace.text === longDocument &&
              userPlace.start === selection + 2 &&
              userPlace.end === selection + 2 &&
              userPlace.direction === 'forward',
            'Source pointer fixture did not move the caret',
          );
        }
        if (
          [
            'font-pending-other-input',
            'font-pending-other-radio',
            'font-pending-radio-key',
          ].includes(testCase)
        ) {
          const target =
            testCase === 'font-pending-radio-key' ? radio : document.createElement('input');
          if (target !== radio) {
            target.type = testCase === 'font-pending-other-radio' ? 'radio' : 'text';
            target.name = testCase === 'font-pending-other-radio' ? 'other-font' : 'code-font';
            target.hidden = true;
            host.append(target);
          }
          const event =
            target === radio
              ? new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
              : new Event('input', { bubbles: true });
          boundaryAction = {
            type: target.type,
            name: target.name,
            event: event.type,
            trusted: event.isTrusted,
          };
          try {
            target.dispatchEvent(event);
          } finally {
            if (target !== radio) target.remove();
          }
          // These public boundary events have no native default. Move only scroll, without another cancellation event.
          const beforeMove = field.scrollTop;
          field.scrollBy({ top: 240, behavior: 'instant' });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          userPlace = Object.freeze(snapshot());
          check(
            userPlace.scrollTop === beforeMove + 240 &&
              userPlace.text === longDocument &&
              userPlace.start === selection &&
              userPlace.end === selection + 8 &&
              userPlace.direction === 'backward',
            'Nonmatching font-control event did not establish the newer source position',
          );
        }
        const expectedAtSettlement = userPlace ?? expected;
        release();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const frame1 = snapshot();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const frame2 = snapshot();
        const evidence = JSON.stringify({
          testCase,
          expected,
          expectedAtSettlement,
          beforeAdjustment,
          pending,
          frame1,
          frame2,
          method: {
            font: radio.value,
            radioInputs,
            sourceInputs,
            sourceNavigation,
            boundaryAction,
            action: boundaryAction
              ? 'nonmatching input/radio navigation event + explicit 240px source move'
              : testCase === 'font-pending-input'
                ? 'native textarea insertText without keyboard events'
                : testCase === 'font-pending-wheel'
                  ? 'public source wheel event + explicit 240px scrollBy default'
                  : testCase === 'font-pending-key'
                    ? 'public source ArrowRight keydown + explicit collapsed caret'
                    : testCase === 'font-pending-pointer'
                      ? 'public source pointerdown + explicit new caret'
                      : 'font radio click',
            layoutOffset:
              testCase === 'font-pending-restore'
                ? 'observed 1px non-user offset simulated via scrollTop only'
                : 'none',
            settlement:
              'native FontFaceSet.load and fonts.ready before gate release; exactly two frames, no position polling',
          },
          requests,
          faces: faces.map((group) =>
            group.map((face) => ({ family: face.family, status: face.status })),
          ),
        });
        check(
          JSON.stringify(frame2) === JSON.stringify(expectedAtSettlement),
          'Pending font settlement lost immutable source position: ' + evidence,
        );
        return testCase + ': ' + evidence;
      } finally {
        release();
        document.fonts.load = nativeLoad;
        window.removeEventListener('input', observeInput, true);
        for (const event of ['wheel', 'keydown', 'pointerdown'])
          window.removeEventListener(event, observeNavigation, true);
      }
    } else if (testCase === 'font-source-position') {
      check(sourceTop === 1400, 'Invalid font source scroll fixture');
      click('button[aria-label="排版设置"]');
      await until(() => document.querySelector('.typography-panel'));
      const nativeLoad = document.fonts.load;
      let loads: Promise<FontFace[]>[] = [];
      document.fonts.load = (font, text) => {
        const loaded = nativeLoad.call(document.fonts, font, text);
        loads.push(loaded);
        return loaded;
      };
      try {
        for (const font of ['fira-wenkai', 'cascadia-misans', 'jetbrains-sarasa']) {
          const radio = document.querySelector<HTMLInputElement>(
            `input[name="code-font"][value="${font}"]`,
          )!;
          const changed = !radio.checked;
          loads = [];
          radio.click();
          if (changed) await until(() => loads.length > 0);
          const faces = await Promise.all(loads);
          await document.fonts.ready;
          check(
            faces.every(
              (group) => group.length > 0 && group.every((face) => face.status === 'loaded'),
            ),
            'Font position test did not load the real bundled fonts',
          );
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          check(
            field.selectionStart === selection && field.selectionEnd === selection + 8,
            'Font change lost source selection',
          );
          check(
            field.selectionDirection === 'backward',
            'Font change lost source selection direction',
          );
          check(field.scrollTop === sourceTop, 'Font change moved source scroll position');
          check(field.value === longDocument, 'Font change edited Markdown');
        }
      } finally {
        document.fonts.load = nativeLoad;
      }
    } else if (testCase === 'rendered-tab-position') {
      click('button[aria-label="切换源码模式"]');
      await until(() => !document.querySelector('.source-editor:not([hidden])'));
      const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
      const scroller = document.querySelector<HTMLElement>(
        '.editor-tab.active .milkdown-container',
      )!;
      scroller.scrollTop = 1500;
      click('button[title="新建文档 (Ctrl+N)"]');
      await until(() => document.querySelector('.newfile-card'));
      click('.newfile-card');
      await until(() => document.querySelectorAll('[role="tab"]').length === 2);
      click('[role="tab"]');
      await until(() => document.querySelector('.editor-tab.active .ProseMirror') === editor);
      check(scroller.scrollTop === 1500, 'Switching rendered tabs lost viewport');
      check(
        editor.querySelectorAll('h2').length === 35,
        'Source edits in a background tab were not synchronized',
      );
    } else if (testCase === 'source-tab-history') {
      click('button[title="新建文档 (Ctrl+N)"]');
      await until(() => document.querySelector('.newfile-card'));
      click('.newfile-card');
      await until(() => document.querySelectorAll('[role="tab"]').length === 2);
      click('[role="tab"]');
      await until(() => document.querySelector('[role="tab"]')?.classList.contains('active'));
      if (!document.querySelector('.source-editor:not([hidden])'))
        click('button[aria-label="切换源码模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden])'));
      field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
      check(field.value === longDocument, 'Tab switch changed the source draft');
      check(
        field.selectionStart === selection && field.selectionEnd === selection + 8,
        `Tab switch lost source selection: ${field.selectionStart},${field.selectionEnd} expected ${selection}`,
      );
      check(field.scrollTop === sourceTop, 'Tab switch lost source scroll');
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      await until(() => field.value === '');
    } else {
      click('button[aria-label="切换源码模式"]');
      await until(() => !document.querySelector('.source-editor:not([hidden])'));
      const scroller = document.querySelector<HTMLElement>(
        '.editor-tab.active .milkdown-container',
      )!;
      if (testCase === 'mode-reading-anchor') {
        check(
          scroller.scrollTop > 500,
          'Mode switch returned to document top instead of the reading paragraph',
        );
      }
      click('button[aria-label="切换源码模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden])'));
      field = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) textarea')!;
      check(
        field.selectionStart === selection && field.selectionEnd === selection + 8,
        `Mode round trip lost source selection: ${field.selectionStart},${field.selectionEnd} expected ${selection}`,
      );
      check(field.selectionDirection === 'backward', 'Mode round trip lost selection direction');
      check(Math.abs(field.scrollTop - sourceTop) < 2, 'Mode round trip moved reading position');
    }
    return `${testCase}: real source editor state survives view changes`;
  } finally {
    root.unmount();
    host.remove();
  }
}
