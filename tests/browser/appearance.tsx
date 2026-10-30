import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { createEditor, getCurrentState } from '../../src/lib/editor';
import { CODE_FONTS, CODE_FONT_STORAGE_KEY } from '../../src/lib/editorFont';
import '../../src/styles/global.css';

export const appearanceCases = [
  'images-centered', 'theme-system-light', 'theme-system-change', 'font-presets',
  'theme-crossfade', 'theme-source-crossfade', 'theme-reduced-motion',
  'theme-no-transition-api', 'theme-rapid-toggle', 'theme-quiet-dialog',
] as const;
export type AppearanceCase = typeof appearanceCases[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function until(condition: () => unknown) {
  const deadline = performance.now() + 30000;
  while (!condition()) {
    check(performance.now() < deadline, 'Appearance regression timed out');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector);
  check(element, `Missing control: ${selector}`);
  element.click();
}

export async function runAppearanceRegression(testCase: AppearanceCase): Promise<string> {
  if (testCase === 'images-centered') {
    const host = document.createElement('div');
    host.className = 'milkdown-container';
    document.body.append(host);
    const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="140" height="80"><rect width="140" height="80" fill="teal"/></svg>');
    const editor = createEditor(host, `![](${svg})\n![](${svg})\n\nBefore ![](${svg}) after`, { onUpdate: () => {} });
    await editor.create();
    try {
      const markdown = getCurrentState(editor).markdown;
      const images = [...host.querySelectorAll<HTMLImageElement>('img:not(.ProseMirror-separator)')];
      await until(() => images.length === 3 && images.every((image) => image.naturalWidth > 0));
      for (const zoom of [1, 1.2, 2]) {
        host.style.setProperty('--editor-zoom', String(zoom));
        const paragraph = images[0].closest('p')!.getBoundingClientRect();
        for (const image of images.slice(0, 2)) {
          const box = image.getBoundingClientRect();
          check(Math.abs(box.x + box.width / 2 - paragraph.x - paragraph.width / 2) < 1,
            `Image is not centered at ${zoom * 100}%`);
        }
        check(images[1].getBoundingClientRect().top >= images[0].getBoundingClientRect().bottom,
          'Consecutive pasted images must be stacked');
      }
      check(getComputedStyle(images[2]).display !== 'block', 'Inline image was pulled out of surrounding text');
      check(getCurrentState(editor).markdown === markdown, 'Image layout changed Markdown content');
      return `${testCase}: centered at 100/120/200%, inline image and Markdown preserved`;
    } finally {
      await editor.destroy();
      host.remove();
    }
  }

  const nativeMatchMedia = window.matchMedia.bind(window);
  const nativeTransition = document.startViewTransition?.bind(document);
  const transitions: ViewTransition[] = [];
  document.startViewTransition = testCase === 'theme-no-transition-api'
    ? undefined as unknown as typeof document.startViewTransition
    : (callback) => {
      const transition = nativeTransition!(callback);
      transitions.push(transition);
      return transition;
    };
  const media = new EventTarget();
  let dark = false;
  Object.assign(media, { media: '(prefers-color-scheme: dark)' });
  Object.defineProperty(media, 'matches', { get: () => dark });
  window.matchMedia = (query) => {
    if (query === '(prefers-color-scheme: dark)') return media as MediaQueryList;
    if (query === '(prefers-reduced-motion: reduce)' && testCase === 'theme-reduced-motion') {
      return { matches: true } as MediaQueryList;
    }
    return nativeMatchMedia(query);
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(<App />);
  try {
    await until(() => document.querySelector('button[title="新建文档 (Ctrl+N)"]'));
    click('button[title="新建文档 (Ctrl+N)"]');
    await until(() => document.querySelector('.newfile-card'));
    if (testCase === 'theme-quiet-dialog') {
      for (const element of document.querySelectorAll('.modal, .newfile-card')) {
        check(getComputedStyle(element).transform === 'none', 'Dialog moved or scaled during entry');
        for (const animation of element.getAnimations()) {
          const frames = (animation.effect as KeyframeEffect).getKeyframes();
          check(frames.every((frame) => !frame.transform || frame.transform === 'none'), 'Dialog retains decorative movement keyframes');
        }
      }
      return `${testCase}: modal and options have no scale, slide or bounce`;
    }
    click('.newfile-card:nth-child(2)');
    const ready = () => document.querySelector('.md-mermaid-holder img')
      && !document.querySelector('.md-mermaid-node.loading')
      && !document.documentElement.classList.contains('theme-transitioning');
    await until(ready);
    if (['theme-crossfade', 'theme-source-crossfade', 'theme-reduced-motion', 'theme-no-transition-api', 'theme-rapid-toggle'].includes(testCase)) {
      await document.fonts.ready;
      transitions.length = 0;
      if (testCase === 'theme-source-crossfade') {
        click('button[aria-label="切换源码模式"]');
        await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'));
      }
      const source = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea');
      const scroller = source ?? document.querySelector<HTMLElement>('.milkdown-container')!;
      scroller.scrollTop = 600;
      source?.setSelectionRange(24, 32);
      source?.focus();
      const scrollTop = scroller.scrollTop;
      const holder = document.querySelector<HTMLElement>('.md-mermaid-holder')!;
      const initialBox = holder.getBoundingClientRect();
      const before = source?.value;
      click('button[aria-label="切换主题,当前为浅色"]');
      await until(() => document.querySelector('button[aria-label="切换主题,当前为深色"]'));
      if (testCase === 'theme-rapid-toggle') {
        click('button[aria-label="切换主题,当前为深色"]');
        await until(() => document.querySelector('button[aria-label="切换主题,当前为跟随系统"]'));
        click('button[aria-label="切换主题,当前为跟随系统"]');
        await until(() => document.documentElement.dataset.theme === 'light' && ready());
      } else if (testCase === 'theme-reduced-motion' || testCase === 'theme-no-transition-api') {
        await until(() => document.documentElement.dataset.theme === 'dark' && ready());
        check(transitions.length === 0, 'Reduced motion / unsupported engine started a snapshot animation');
      } else {
        check(transitions.length === 1, 'Theme did not start a single coordinated transition');
        await transitions[0].ready;
        check(holder.querySelector('.md-mermaid-preview img')?.getBoundingClientRect().height,
          'Snapshot lost the previous diagram while its font-aware replacement was loading');
        const fade = document.getAnimations().find((animation) => (animation as CSSAnimation).animationName === 'theme-fade-out');
        check(fade && fade.effect?.getTiming().duration === 280, 'Expected one 280ms theme crossfade');
        check(getComputedStyle(document.querySelector('.editor-area')!).backgroundColor === 'rgb(21, 30, 39)',
          'Panel transitions left the new snapshot in an intermediate color');
        await transitions[0].finished;
        await until(ready);
      }
      const afterBox = holder.getBoundingClientRect();
      check(initialBox.top === afterBox.top && initialBox.height === afterBox.height,
        `Theme animation moved the diagram: ${JSON.stringify(initialBox.toJSON())} => ${JSON.stringify(afterBox.toJSON())}`);
      check(holder.querySelector<HTMLImageElement>('.md-mermaid-preview img')!.naturalWidth > 0,
        'Diagram replacement did not decode');
      check(scroller.scrollTop === scrollTop, 'Theme animation moved the scroll position');
      if (source) {
        check(source.value === before && source.selectionStart === 24 && source.selectionEnd === 32,
          'Theme animation modified the source draft or selection');
      }
      await until(() => !document.documentElement.classList.contains('theme-transitioning'));
      return `${testCase}: theme feedback, geometry, scroll and source draft passed`;
    }
    if (testCase === 'font-presets') {
      click('button[aria-label="切换源码模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'));
      const source = document.querySelector<HTMLTextAreaElement>('.source-editor:not([hidden]) .source-textarea')!;
      const before = source.value;
      const bodyFont = getComputedStyle(document.querySelector('.ProseMirror')!).fontFamily;
      click('button[aria-label="排版设置"]');
      await until(() => document.querySelector('.typography-panel'));
      for (const font of CODE_FONTS) {
        const select = document.querySelector<HTMLSelectElement>('select[aria-label="源码与代码字体"]')!;
        select.value = font.id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => localStorage.getItem(CODE_FONT_STORAGE_KEY) === font.id);
        for (const family of font.family.split(', ')) {
          const faces = await document.fonts.load(`16px ${family}`, 'Hello 中文，标点');
          check(faces.length > 0 && faces.every((face) => face.status === 'loaded'), `Bundled font failed to load: ${family}`);
        }
        for (const element of [source, document.querySelector('.ProseMirror pre code')!]) {
          check(getComputedStyle(element).fontFamily.startsWith(font.family), `Preset not applied: ${font.label}`);
        }
        check(getComputedStyle(document.querySelector('.ProseMirror')!).fontFamily === bodyFont, 'Code choice changed prose typography');
        check(source.value === before, 'Changing fonts modified the source draft');
      }
      return `${testCase}: all six offline code-pair faces loaded; independent presets persisted without editing content`;
    }
    click('button[aria-label="切换主题,当前为浅色"]');
    await until(() => document.documentElement.dataset.theme === 'dark' && ready());
    click('button[aria-label="切换主题,当前为深色"]');
    await until(() => document.documentElement.dataset.theme === 'light' && ready());
    const frame = document.querySelector<HTMLImageElement>('.md-mermaid-holder img')!;
    const scroller = document.querySelector<HTMLElement>('.milkdown-container')!;
    document.querySelector<HTMLElement>('.editor-area')!.style.setProperty('--editor-zoom', '1.2');
    scroller.scrollTop = 700;
    const top = scroller.scrollTop;
    const box = frame.getBoundingClientRect();
    if (testCase === 'theme-system-light') {
      click('button[aria-label="切换主题,当前为跟随系统"]');
      await until(() => document.querySelector('button[aria-label="切换主题,当前为浅色"]'));
      check(!document.querySelector('.md-mermaid-node.loading'), 'System-light to light unnecessarily rerenders Mermaid');
      check(document.querySelector('.md-mermaid-holder img') === frame, 'Unchanged resolved theme replaced the diagram');
      check(scroller.scrollTop === top, 'Unchanged resolved theme moved the scroll position');
      const after = frame.getBoundingClientRect();
      check(after.top === box.top && after.height === box.height && after.width === box.width,
        'Unchanged resolved theme moved or resized the diagram at 120% zoom');
    } else {
      dark = true;
      media.dispatchEvent(new Event('change'));
      await until(() => document.documentElement.dataset.theme === 'dark');
      await until(ready);
      check(document.querySelector('.md-mermaid-holder img') !== frame, 'System color change kept the old diagram theme');
    }
    return `${testCase}: real App theme control and Mermaid lifecycle passed`;
  } finally {
    root.unmount();
    host.remove();
    window.matchMedia = nativeMatchMedia;
    document.startViewTransition = nativeTransition!;
  }
}
