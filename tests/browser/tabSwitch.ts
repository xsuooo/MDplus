import { createNativeMocks } from './nativeMocks';
import { longDocument } from './continuity';

const documents = Array.from({ length: 12 }, (_, index) => ({
  title:
    index % 3 === 0
      ? `${index}.md`
      : index % 3 === 1
        ? `中英标题-${index}-notes.md`
        : `a-much-longer-document-title-${index}.md`,
  content: `# Document ${index}\n\nSelection token-${index} lives here.\n\n${index % 2 === 0 ? longDocument : 'A short document.\n'}`,
}));

/** All files and writes stay in memory; the actual App still opens and owns every editor. */
export function installTabSwitchMocks() {
  const defaults = createNativeMocks();
  const files = new Map(
    documents.map((entry) => [
      `C:/tab-switch-fixture/${entry.title}`,
      { content: entry.content, revision: 'fixture:initial' },
    ]),
  );
  createNativeMocks({
    fallback(command, args) {
      if (command === 'take_startup_files') return [...files.keys()];
      if (command === 'read_document' || command === 'document_revision') {
        const path = String(args.path);
        const file = files.get(path);
        check(file, `Unknown synthetic file: ${path}`);
        return { path, content: file.content, revision: file.revision, mtime: 1 };
      }
      if (command === 'write_document') {
        const path = String(args.path);
        const file = files.get(path);
        check(file && args.expectedRevision === file.revision, 'Synthetic write lost revision');
        file.content = String(args.content);
        file.revision += ':saved';
        return { path, revision: file.revision, mtime: 1, backupPath: null };
      }
      return defaults.invoke(command, args);
    },
  }).install();
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => unknown) {
  const deadline = performance.now() + 15000;
  while (!condition()) {
    check(performance.now() < deadline, 'Tab switching fixture timed out');
    await frame();
  }
}
async function settle() {
  await frame();
  await frame();
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => {})),
  );
}
function box(element: Element) {
  const rect = element.getBoundingClientRect();
  return [rect.left, rect.top, rect.width, rect.height];
}
function difference(before: number[], after: number[]) {
  return Math.max(...before.map((value, index) => Math.abs(value - after[index])));
}
type RenderedDOM = HTMLElement & { pmViewDesc?: { node: object } };
function parsedDocument(editor: RenderedDOM) {
  // ProseMirror's root view descriptor points to the actual parsed document, not a text copy.
  const doc = editor.pmViewDesc?.node;
  check(doc, 'Initialized ProseMirror document is missing');
  return doc;
}
function toggleSource() {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="切换源码模式"]');
  check(button, 'Source mode toggle is missing');
  button.click();
}
function input(source: HTMLTextAreaElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(source, text);
  source.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function checkTabSwitches(sourceMode: boolean): Promise<string> {
  await until(() => document.querySelectorAll('.ProseMirror').length === documents.length);
  await until(() => document.querySelectorAll('.source-textarea').length === documents.length);
  await document.fonts.ready;
  await settle();
  const headers = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.editor-tab'));
  const sources = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.source-textarea'));
  check(headers.length === 12, 'The tab switching fixture must initialize all 12 tabs');
  const states = documents.map((entry, index) => {
    const order = headers.findIndex(
      (header) => header.querySelector('.tab-title')?.textContent === entry.title,
    );
    check(order >= 0, 'Synthetic tab title was lost');
    const panel = panels[order];
    const editor = panel.querySelector<RenderedDOM>('.ProseMirror')!;
    const source = sources[order];
    check(
      editor.textContent?.includes(`token-${index}`) && source.value.includes(`token-${index}`),
      'A synthetic tab displays another document',
    );
    return { index, header: headers[order], panel, editor, source };
  });
  const seeded: ((typeof states)[number] & {
    surface: HTMLElement;
    content: HTMLElement;
    paragraph: HTMLParagraphElement;
    paragraphIndex: number;
    node: ChildNode;
    start: number;
    end: number;
    scroller: HTMLElement;
    doc: object;
    markdown: string;
    top: number;
    surfaceBox: number[];
    contentBox: number[];
    paragraphBox: number[];
  })[] = [];
  for (const state of states) {
    state.header.click();
    await settle();
    // Real source input must synchronize back to the same mounted rich editor.
    if (sourceMode || state.index === 3) {
      toggleSource();
      await until(() => !state.source.closest<HTMLElement>('.source-editor')!.hidden);
      input(
        state.source,
        state.source.value.replace(`token-${state.index}`, `revised-token-${state.index}`),
      );
      await frame();
      toggleSource();
      await until(() => state.editor.textContent?.includes(`revised-token-${state.index}`));
      await settle();
    }
    const paragraphIndex = !sourceMode && state.index % 2 === 0 ? 5 + (state.index % 6) : 0;
    const paragraph = state.editor.querySelectorAll('p')[paragraphIndex];
    const scroller = state.panel.querySelector<HTMLElement>('.milkdown-container')!;
    const node = paragraph.firstChild!;
    const start = 2 + (state.index % 4),
      end = start + 8;
    if (sourceMode) {
      toggleSource();
      await until(() => !state.source.closest<HTMLElement>('.source-editor')!.hidden);
      await settle();
      state.source.setSelectionRange(start, end, 'backward');
      state.source.dispatchEvent(new Event('select', { bubbles: true }));
      state.source.scrollTop = state.index % 2 === 0 ? 480 + state.index * 17 : 0;
      state.source.dispatchEvent(new Event('scroll'));
    } else {
      state.editor.focus({ preventScroll: true });
      document.getSelection()!.setBaseAndExtent(node, end, node, start);
      document.dispatchEvent(new Event('selectionchange'));
      await frame();
      await frame();
      scroller.scrollTop =
        state.index % 2 === 0
          ? scroller.scrollTop +
            paragraph.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            140
          : 0;
    }
    await frame();
    const surface = sourceMode ? state.source.closest<HTMLElement>('.source-editor')! : state.panel;
    const content = sourceMode ? state.source : state.editor;
    seeded.push({
      ...state,
      surface,
      content,
      paragraph,
      paragraphIndex,
      node,
      start,
      end,
      scroller,
      doc: parsedDocument(state.editor),
      markdown: state.source.value,
      top: sourceMode ? state.source.scrollTop : scroller.scrollTop,
      surfaceBox: box(surface),
      contentBox: box(content),
      paragraphBox: box(paragraph),
    });
  }
  const strip = document.querySelector<HTMLElement>('.tabbar-tabs')!;
  document.querySelector<HTMLElement>('.tabbar')!.style.width = '760px';
  check(strip.scrollWidth > strip.clientWidth + 100, 'The fixture must overflow the tab strip');
  seeded[4].header.click();
  await settle();
  strip.scrollTo({
    left:
      strip.scrollLeft +
      seeded[4].header.getBoundingClientRect().left -
      strip.getBoundingClientRect().left -
      12,
    behavior: 'instant',
  });
  await settle();
  const neighbors = seeded.slice(4, 7);
  const visible = (header: HTMLElement) => {
    const tab = header.getBoundingClientRect(),
      viewport = strip.getBoundingClientRect();
    return tab.left >= viewport.left - 0.5 && tab.right <= viewport.right + 0.5;
  };
  check(
    neighbors.every((state) => visible(state.header)),
    'Stable-width comparisons require already visible neighboring tabs',
  );
  const headerBoxes = neighbors.map((state) => box(state.header));
  const initialStripLeft = strip.scrollLeft;
  const failures = new Set<string>();
  let pointerFocus: {
    pointerEvents: number;
    activeBeforePointer: boolean;
    contentFocusedBeforeFrame: boolean;
    contentFocusedAfterFrame: boolean;
    headerFocusedAfterFrame: boolean;
    activeAfterFrame: boolean;
  } | null = null;
  const samples: {
    index: number;
    phase: string;
    opacity: number;
    transform: string;
    geometryDelta: number;
    scrollDelta: number;
    headerDelta?: number;
  }[] = [];
  const observe = (index: number, phase: string, stableHeader: boolean) => {
    const state = seeded[index],
      style = getComputedStyle(state.surface),
      childStyle = getComputedStyle(state.content);
    const opacity = Number(style.opacity) * Number(childStyle.opacity);
    const transform = style.transform === 'none' ? childStyle.transform : style.transform;
    const geometryDelta = Math.max(
      difference(state.surfaceBox, box(state.surface)),
      difference(state.contentBox, box(state.content)),
      sourceMode ? 0 : difference(state.paragraphBox, box(state.paragraph)),
    );
    const scrollDelta = Math.abs(
      (sourceMode ? state.source.scrollTop : state.scroller.scrollTop) - state.top,
    );
    const headerDelta = stableHeader
      ? Math.max(
          ...neighbors.map((neighbor, at) => difference(headerBoxes[at], box(neighbor.header))),
        )
      : undefined;
    samples.push({ index, phase, opacity, transform, geometryDelta, scrollDelta, headerDelta });
    if (opacity < 0.999 || transform !== 'none')
      failures.add(`${phase}: active content fades or transforms`);
    if (geometryDelta > 0.5 || scrollDelta > 1)
      failures.add(`${phase}: tab ${index} geometry/scroll moved`);
    if (stableHeader && (headerDelta! > 0.5 || Math.abs(strip.scrollLeft - initialStripLeft) > 0.5))
      failures.add('Already visible tabs resized or moved while changing active title weight');
    if (!visible(state.header)) failures.add(`${phase}: active tab is clipped`);
    if (!state.header.classList.contains('active') || !state.panel.classList.contains('active'))
      failures.add('Visible content and active tab disagree');
    if (
      parsedDocument(state.editor) !== state.doc ||
      state.editor.querySelectorAll('p')[state.paragraphIndex] !== state.paragraph
    )
      failures.add('Switching recreated a document or unchanged paragraph');
    if (state.source.value !== state.markdown) failures.add('Switching changed source content');
    if (
      sourceMode &&
      (state.source.selectionStart !== state.start ||
        state.source.selectionEnd !== state.end ||
        state.source.selectionDirection !== 'backward' ||
        document.activeElement !== state.source)
    )
      failures.add('Source switching lost caret, selection direction or focus');
  };
  // No settling between switches: sample the first display frame on every return.
  for (const index of [5, 6, 4, 6, 5, 4, 5, 6, 4, 5, 6, 4]) {
    seeded[index].header.click();
    await frame();
    observe(index, 'first-frame', true);
  }
  await settle();
  observe(4, 'settled', true);
  // Offscreen navigation is a separate assertion, rather than treating its reveal as jitter.
  for (const index of [11, 0, 11, 0]) {
    if (sourceMode) seeded[index].header.click();
    else {
      seeded[index].header.focus({ preventScroll: true });
      seeded[index].header.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: index ? 'End' : 'Home',
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    await frame();
    observe(index, 'offscreen-first-frame', false);
    await settle();
    await until(() => visible(seeded[index].header));
    observe(index, 'offscreen-settled', false);
  }
  for (const state of seeded) {
    state.header.click();
    await settle();
    if (!sourceMode) {
      state.editor.focus({ preventScroll: true });
      // ProseMirror restores the DOM selection shortly after the focus event.
      await frame();
      await frame();
      await frame();
      const selection = document.getSelection()!;
      if (
        selection.anchorNode !== state.node ||
        selection.focusNode !== state.node ||
        selection.anchorOffset !== state.end ||
        selection.focusOffset !== state.start
      )
        failures.add(`Rich tab ${state.index} lost its backward selection`);
      if (Math.abs(state.scroller.scrollTop - state.top) > 1)
        failures.add(`Rich tab ${state.index} focus changed remembered scroll`);
    } else if (
      state.source.selectionStart !== state.start ||
      state.source.selectionEnd !== state.end ||
      state.source.selectionDirection !== 'backward'
    )
      failures.add(`Source tab ${state.index} lost its selection`);
    if (parsedDocument(state.editor) !== state.doc || state.source.value !== state.markdown)
      failures.add(`Tab ${state.index} identity/content changed`);
  }
  if (!sourceMode) {
    seeded[4].header.focus({ preventScroll: true });
    seeded[4].header.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
    );
    seeded[5].header.focus({ preventScroll: true });
    seeded[5].header.click();
    await frame();
    await frame();
    if (
      !seeded[5].header.classList.contains('active') ||
      document.activeElement !== seeded[5].header
    )
      failures.add('A superseded keyboard selection stole focus from the latest clicked tab');

    // Commit the selected tab in a microtask, then point into its body before the RAF.
    // The active ID stays the same, and this interaction never invokes a tab click.
    const pointed = seeded[seeded.length - 1];
    seeded[5].header.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    const activeBeforePointer =
      pointed.header.classList.contains('active') && pointed.panel.classList.contains('active');
    check(activeBeforePointer, 'Keyboard selection did not commit before pointer interaction');
    let pointerEvents = 0;
    const capturePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && pointed.editor.contains(event.target)) pointerEvents++;
    };
    window.addEventListener('pointerdown', capturePointer, true);
    try {
      const rect = pointed.paragraph.getBoundingClientRect();
      pointed.paragraph.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
      pointed.editor.focus({ preventScroll: true });
      const contentFocusedBeforeFrame = document.activeElement === pointed.editor;
      check(
        pointerEvents === 1 && contentFocusedBeforeFrame,
        'Pointer fixture did not focus the live editor',
      );
      await frame();
      pointerFocus = {
        pointerEvents,
        activeBeforePointer,
        contentFocusedBeforeFrame,
        contentFocusedAfterFrame: document.activeElement === pointed.editor,
        headerFocusedAfterFrame: document.activeElement === pointed.header,
        activeAfterFrame: pointed.header.classList.contains('active'),
      };
      if (!pointerFocus.contentFocusedAfterFrame || !pointerFocus.activeAfterFrame)
        failures.add(
          'Pending keyboard focus stole focus after pointer input in the same active document',
        );
    } finally {
      window.removeEventListener('pointerdown', capturePointer, true);
    }
  } else {
    // Every source draft must still render correctly after rapid switching.
    for (const state of seeded) {
      state.header.click();
      await frame();
      toggleSource();
      await until(() => state.editor.textContent?.includes(`revised-token-${state.index}`));
      check(
        state.panel.querySelector('.ProseMirror') === state.editor,
        'Source synchronization remounted the rich editor',
      );
    }
    // Input and switching can occur in one task, before the throttled tab render.
    const edited = seeded[2];
    edited.header.click();
    await frame();
    toggleSource();
    await until(() => !edited.source.closest<HTMLElement>('.source-editor')!.hidden);
    input(edited.source, `${edited.source.value}\n\nImmediate source marker.\n`);
    seeded[3].header.click();
    await frame();
    check(seeded[3].source.value === seeded[3].markdown, 'Rapid input leaked to another tab');
    edited.header.click();
    await frame();
    toggleSource();
    await until(() => edited.editor.textContent?.includes('Immediate source marker.'));
    check(
      edited.panel.querySelector('.ProseMirror') === edited.editor,
      'Immediately switched source input remounted the rich editor',
    );
  }
  const detail = JSON.stringify({
    mode: sourceMode ? 'source' : 'rich',
    initializedTabs: seeded.length,
    sourceSync: true,
    pointerFocus,
    failures: [...failures],
    samples,
  });
  check(!failures.size, `Tab switch regression: ${detail}`);
  return `Tab switch regression passed: ${detail}`;
}
