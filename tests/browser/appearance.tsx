import { createRoot } from 'react-dom/client';
import { createNativeMocks } from './nativeMocks';
import App from '../../src/App';
import { createEditor, getCurrentState } from '../../src/lib/editor';
import { CODE_FONTS, CODE_FONT_STORAGE_KEY } from '../../src/lib/editorFont';
import '../../src/styles/global.css';

export const appearanceCases = [
  'images-centered',
  'theme-system-light',
  'theme-system-change',
  'font-presets',
  'theme-colors',
  'theme-source-colors',
  'theme-reduced-motion',
  'theme-initial-render',
  'theme-rapid-toggle',
  'theme-quiet-dialog',
  'theme-pointer-through',
  'theme-outline-budget',
  'theme-document-budget',
] as const;
export type AppearanceCase = (typeof appearanceCases)[number];

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

// Compare rendered surfaces with semantic tokens, not a superseded fixed palette.
function tokenColor(token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector);
  check(element, `Missing control: ${selector}`);
  element.click();
}

function clickHit(selector: string) {
  const control = document.querySelector<HTMLElement>(selector)!;
  const box = control.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  check(hit && control.contains(hit), `Theme animation intercepts pointer input: ${selector}`);
  control.click();
}

async function settleAnimations() {
  await new Promise(requestAnimationFrame);
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => {})),
  );
}

export async function runAppearanceRegression(testCase: AppearanceCase): Promise<string> {
  createNativeMocks().install();
  if (testCase === 'images-centered') {
    const host = document.createElement('div');
    host.className = 'milkdown-container';
    document.body.append(host);
    const svg =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="80"><rect width="140" height="80" fill="teal"/></svg>',
      );
    const editor = createEditor(host, `![](${svg})\n![](${svg})\n\nBefore ![](${svg}) after`, {
      onUpdate: () => {},
    });
    await editor.create();
    try {
      const markdown = getCurrentState(editor).markdown;
      const images = [
        ...host.querySelectorAll<HTMLImageElement>('img:not(.ProseMirror-separator)'),
      ];
      await until(() => images.length === 3 && images.every((image) => image.naturalWidth > 0));
      for (const zoom of [1, 1.2, 2]) {
        host.style.setProperty('--editor-zoom', String(zoom));
        const paragraph = images[0].closest('p')!.getBoundingClientRect();
        for (const image of images.slice(0, 2)) {
          const box = image.getBoundingClientRect();
          check(
            Math.abs(box.x + box.width / 2 - paragraph.x - paragraph.width / 2) < 1,
            `Image is not centered at ${zoom * 100}%`,
          );
        }
        check(
          images[1].getBoundingClientRect().top >= images[0].getBoundingClientRect().bottom,
          'Consecutive pasted images must be stacked',
        );
      }
      check(
        getComputedStyle(images[2]).display !== 'block',
        'Inline image was pulled out of surrounding text',
      );
      check(getCurrentState(editor).markdown === markdown, 'Image layout changed Markdown content');
      return `${testCase}: centered at 100/120/200%, inline image and Markdown preserved`;
    } finally {
      await editor.destroy();
      host.remove();
    }
  }

  const nativeMatchMedia = window.matchMedia.bind(window);
  const media = new EventTarget();
  let dark = false;
  Object.assign(media, { media: '(prefers-color-scheme: dark)' });
  Object.defineProperty(media, 'matches', { get: () => dark });
  window.matchMedia = (query) => {
    if (query === '(prefers-color-scheme: dark)') return media as MediaQueryList;
    return nativeMatchMedia(query);
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let restoreMermaid = () => {};
  root.render(<App />);
  try {
    await until(() => document.querySelector('button[title="新建文档 (Ctrl+N)"]'));
    if (testCase === 'theme-initial-render') {
      check(
        document.documentElement.dataset.theme === 'light',
        'Initial theme is not ready for first paint',
      );
      const surface = document.querySelector('.app')!;
      check(
        getComputedStyle(surface).backgroundColor === tokenColor('--bg'),
        'Initial surface is fading from an unthemed background',
      );
      check(
        !surface.getAnimations().some((animation) => animation instanceof CSSTransition),
        'Initial theme has an unnecessary color entrance',
      );
      return `${testCase}: first layout has final colors without a theme entrance`;
    }
    if (testCase === 'theme-quiet-dialog') {
      click('button[aria-label="打开快捷键设置"]');
      await until(() => document.querySelector('.shortcut-modal'));
      for (const element of document.querySelectorAll('.modal, .shortcut-kbd')) {
        check(
          getComputedStyle(element).transform === 'none',
          'Dialog moved or scaled during entry',
        );
        for (const animation of element.getAnimations()) {
          const frames = (animation.effect as KeyframeEffect).getKeyframes();
          check(
            frames.every((frame) => !frame.transform || frame.transform === 'none'),
            'Dialog retains decorative movement keyframes',
          );
        }
      }
      return `${testCase}: dialog and controls have no scale, slide or bounce`;
    }
    await until(() => document.querySelector('.welcome-example'));
    click('.welcome-example');
    const ready = () =>
      document.querySelector('.md-mermaid-holder img') &&
      !document.querySelector('.md-mermaid-node.loading');
    await until(ready);
    if (testCase === 'theme-outline-budget') {
      const picture =
        'data:image/svg+xml,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="64"><rect width="80" height="64" fill="teal"/></svg>',
        );
      const markdown = Array.from(
        { length: 400 },
        (_, i) =>
          `## Heading ${i}\n\nParagraph ${i}.\n\n${i < 13 ? `![Picture ${i}](${picture})\n\n` : ''}`,
      ).join('');
      click('button[aria-label="切换 Markdown 模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'));
      const source = document.querySelector<HTMLTextAreaElement>(
        '.source-editor:not([hidden]) .source-textarea',
      )!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        source,
        markdown,
      );
      source.dispatchEvent(new Event('input', { bubbles: true }));
      click('button[aria-label="切换 Markdown 模式"]');
      await until(() => !document.querySelector('.source-editor:not([hidden])'));
      click('button[aria-label="打开目录"]');
      await until(() => document.querySelectorAll('.outline-item').length === 400);
      await settleAnimations();
      const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
      const initialText = editor.textContent;
      const scroller = document.querySelector<HTMLElement>(
        '.editor-tab.active .milkdown-container',
      )!;
      scroller.scrollTop = 800;
      const initialScroll = scroller.scrollTop;
      click('button[aria-label="切换主题,当前为浅色"]');
      await until(() => document.documentElement.dataset.theme === 'dark');
      const itemAnimations = document.getAnimations().filter((animation) => {
        const element = (animation.effect as KeyframeEffect | null)?.target;
        return element instanceof Element && element.closest('.outline-body');
      });
      check(
        itemAnimations.length === 0,
        `Theme queued ${itemAnimations.length} directory row animations`,
      );
      check(
        ![...document.querySelectorAll('.md-image-node .md-media-controls')].some(
          (controls) => controls.getAnimations({ subtree: true }).length,
        ),
        'Theme animated hidden image controls',
      );
      await settleAnimations();
      check(
        editor.textContent === initialText && scroller.scrollTop === initialScroll,
        'Theme changed document content or reading position',
      );
      return `${testCase}: 400 directory rows, no per-row theme animations, document and scroll preserved`;
    }
    if (testCase === 'theme-document-budget') {
      const fence = '```';
      const markdown =
        Array.from(
          { length: 300 },
          (_, i) => `- item ${i} with [a link](https://example.com/${i})`,
        ).join('\n') +
        '\n\n' +
        Array.from(
          { length: 12 },
          (_, i) => `${fence}ts\nconst value${i} = ${i};\n${fence}\n`,
        ).join('\n');
      click('button[aria-label="切换 Markdown 模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'));
      const source = document.querySelector<HTMLTextAreaElement>(
        '.source-editor:not([hidden]) .source-textarea',
      )!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        source,
        markdown,
      );
      source.dispatchEvent(new Event('input', { bubbles: true }));
      click('button[aria-label="切换 Markdown 模式"]');
      await until(() => !document.querySelector('.source-editor:not([hidden])'));
      const editor = document.querySelector<HTMLElement>('.editor-tab.active .ProseMirror')!;
      await until(
        () =>
          editor.querySelectorAll('li').length === 300 &&
          editor.querySelectorAll('.md-code-copy').length === 12,
      );
      await document.fonts.ready;
      await settleAnimations();
      const chrome = () =>
        ['.statusbar-right', '.statusbar-actions', '.statusbar-theme-mode', '.statusbar-version']
          .map((selector) => {
            const box = document.querySelector(selector)!.getBoundingClientRect();
            return `${selector}:${box.left},${box.width}`;
          })
          .join(' ');
      const still = chrome();
      let onChrome = 0;
      for (const [label, theme] of [
        ['浅色', 'dark'],
        ['深色', 'light'],
        ['跟随系统', 'light'],
      ]) {
        click(`button[aria-label="切换主题,当前为${label}"]`);
        await until(
          () =>
            document.documentElement.dataset.theme === theme &&
            !document.querySelector(`button[aria-label="切换主题,当前为${label}"]`),
        );
        await new Promise(requestAnimationFrame);
        const running = document.getAnimations();
        const inDocument = running.filter((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          return target instanceof Element && editor.contains(target);
        });
        check(
          inDocument.length === 0,
          `Theme queued ${inDocument.length} animations inside the document (list markers, code controls)`,
        );
        onChrome = Math.max(onChrome, running.length);
        check(
          chrome() === still,
          `Theme mode after "${label}" moved the status bar: ${still} => ${chrome()}`,
        );
        check(
          getComputedStyle(editor.querySelector('li')!, '::marker').color ===
            tokenColor('--text-muted') &&
            getComputedStyle(editor.querySelector('.md-code-copy')!).color ===
              tokenColor('--text-muted'),
          'List markers or code controls did not take the new theme at once',
        );
        if (theme === 'dark')
          for (const logo of document.querySelectorAll('.toolbar-brand-logo svg'))
            check(
              getComputedStyle(logo).filter === 'none',
              'Dark theme recolors the brand mark with a filter again',
            );
        await settleAnimations();
      }
      check(
        getComputedStyle(document.querySelector('.brand-tile')!).fill ===
          tokenColor('--brand-tile'),
        'Brand tile does not follow its theme token',
      );
      return `${testCase}: 300 list items and 12 code blocks start no theme animation (${onChrome} on the app chrome); status bar stays put through all three modes; brand mark needs no filter`;
    }
    if (
      [
        'theme-colors',
        'theme-source-colors',
        'theme-reduced-motion',
        'theme-rapid-toggle',
        'theme-pointer-through',
      ].includes(testCase)
    ) {
      await document.fonts.ready;
      await settleAnimations();
      if (testCase === 'theme-source-colors' || testCase === 'theme-pointer-through') {
        click('button[aria-label="切换 Markdown 模式"]');
        await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'));
      }
      const source = document.querySelector<HTMLTextAreaElement>(
        '.source-editor:not([hidden]) .source-textarea',
      );
      const scroller = source ?? document.querySelector<HTMLElement>('.milkdown-container')!;
      scroller.scrollTop = 600;
      source?.setSelectionRange(24, 32);
      source?.focus();
      const scrollTop = scroller.scrollTop;
      const holder = document.querySelector<HTMLElement>('.md-mermaid-holder')!;
      const initialBox = holder.getBoundingClientRect();
      const before = source?.value;
      const { default: mermaid } = await import('mermaid');
      const renderDiagram = mermaid.render;
      let diagramRenders = 0;
      mermaid.render = (...args: Parameters<typeof renderDiagram>) => {
        diagramRenders++;
        return renderDiagram(...args);
      };
      restoreMermaid = () => {
        mermaid.render = renderDiagram;
      };
      click('button[aria-label="切换主题,当前为浅色"]');
      await until(() => document.querySelector('button[aria-label="切换主题,当前为深色"]'));
      if (testCase === 'theme-rapid-toggle') {
        click('button[aria-label="切换主题,当前为深色"]');
        await until(() => document.querySelector('button[aria-label="切换主题,当前为跟随系统"]'));
        click('button[aria-label="切换主题,当前为跟随系统"]');
        await until(() => document.documentElement.dataset.theme === 'light' && ready());
      } else if (testCase === 'theme-reduced-motion') {
        check(
          nativeMatchMedia('(prefers-reduced-motion: reduce)').matches,
          'Runner must emulate the actual reduced-motion media feature',
        );
        await until(() => document.documentElement.dataset.theme === 'dark' && ready());
        check(
          parseFloat(
            getComputedStyle(document.querySelector('.editor-area')!).transitionDuration,
          ) <= 0.00001,
          'Reduced-motion CSS still animates theme colors',
        );
      } else {
        const surface = document.querySelector('.editor-area')!;
        const fade = surface
          .getAnimations()
          .find(
            (animation) =>
              animation instanceof CSSTransition &&
              animation.transitionProperty === 'background-color',
          );
        check(
          fade?.effect?.getTiming().duration === 100 && fade.playState === 'running',
          'Expected a live 100ms surface color transition',
        );
        check(
          getComputedStyle(surface).transitionTimingFunction.includes(
            'cubic-bezier(0.22, 1, 0.36, 1)',
          ),
          'Theme easing differs from the shared motion curve',
        );
        if (testCase === 'theme-pointer-through') {
          const box = source!.getBoundingClientRect();
          check(
            document.elementFromPoint(box.left + 20, box.top + 20) === source,
            'Live source editor is not hit-testable during theme feedback',
          );
          source!.focus();
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
            source,
            before + '\nTheme input remains live.',
          );
          source!.dispatchEvent(new Event('input', { bubbles: true }));
          clickHit('button[aria-label="排版设置"]');
          await new Promise(requestAnimationFrame);
          check(
            document.querySelector('.typography-panel'),
            'Theme transition swallowed the next control activation',
          );
          check(
            source!.value.endsWith('Theme input remains live.'),
            'Theme feedback swallowed source editing',
          );
          clickHit('button[aria-label="关闭排版设置"]');
          await settleAnimations();
          clickHit('button[aria-label="切换主题,当前为深色"]');
          await until(() => document.documentElement.dataset.theme === 'light');
          check(
            surface
              .getAnimations()
              .some(
                (animation) =>
                  animation instanceof CSSTransition && animation.playState === 'running',
              ),
            'Search regression missed the in-progress return transition',
          );
          clickHit('button[aria-label="搜索当前文档"]');
          await new Promise(requestAnimationFrame);
          check(
            document.querySelector('.search-input'),
            'Search could not open during the theme transition',
          );
          clickHit('button[aria-label="关闭搜索"]');
          await settleAnimations();
          return `${testCase}: live hit tests, typography, search and source input passed during the transition`;
        }
        check(
          holder.querySelector('.md-mermaid-preview img')?.getBoundingClientRect().height,
          'Theme refresh lost the old diagram while its replacement was loading',
        );
        if (source) {
          const animations = document.querySelector('.source-editor-head')!.getAnimations();
          check(
            animations.some(
              (animation) =>
                animation instanceof CSSTransition &&
                animation.effect?.getTiming().duration === 100,
            ),
            'Source controls did not follow the fast surface feedback',
          );
        } else {
          check(
            holder
              .getAnimations()
              .some(
                (animation) =>
                  animation instanceof CSSTransition &&
                  animation.effect?.getTiming().duration === 100,
              ),
            'Diagram surface did not follow the fast surface feedback',
          );
          for (const [selector, colorToken] of [
            ['.ProseMirror', '--text'],
            ['.ProseMirror h1', '--text-strong'],
            ['.ProseMirror strong', '--text-strong'],
            ['.ProseMirror code', '--code-text'],
          ]) {
            const element = document.querySelector(selector)!;
            check(
              !element.getAnimations().some((animation) => animation instanceof CSSTransition),
              `Document leaf still queues its own theme animation: ${selector}`,
            );
            check(
              getComputedStyle(element).color === tokenColor(colorToken),
              `Document colors did not reach the latest theme immediately: ${selector}`,
            );
          }
        }
        await fade.finished;
        check(diagramRenders === 0, 'Diagram layout started while the surfaces were still fading');
        await until(ready);
        check(diagramRenders > 0, 'Theme change never re-rendered the diagram');
      }
      await settleAnimations();
      const expectedBackground = tokenColor('--editor-bg');
      check(
        getComputedStyle(document.querySelector('.editor-area')!).backgroundColor ===
          expectedBackground,
        'Theme did not settle on the latest surface color',
      );
      const afterBox = holder.getBoundingClientRect();
      check(
        initialBox.top === afterBox.top && initialBox.height === afterBox.height,
        `Theme animation moved the diagram: ${JSON.stringify(initialBox.toJSON())} => ${JSON.stringify(afterBox.toJSON())}`,
      );
      check(
        holder.querySelector<HTMLImageElement>('.md-mermaid-preview img')!.naturalWidth > 0,
        'Diagram replacement did not decode',
      );
      check(scroller.scrollTop === scrollTop, 'Theme animation moved the scroll position');
      if (source) {
        check(
          source.value === before && source.selectionStart === 24 && source.selectionEnd === 32,
          'Theme animation modified the source draft or selection',
        );
      }
      return `${testCase}: theme feedback, geometry, scroll and source draft passed`;
    }
    if (testCase === 'font-presets') {
      click('button[aria-label="切换 Markdown 模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden]) .source-textarea'));
      const source = document.querySelector<HTMLTextAreaElement>(
        '.source-editor:not([hidden]) .source-textarea',
      )!;
      const before = source.value;
      const bodyFont = getComputedStyle(document.querySelector('.ProseMirror')!).fontFamily;
      click('button[aria-label="排版设置"]');
      await until(() => document.querySelector('.typography-panel'));
      for (const font of CODE_FONTS) {
        document
          .querySelector<HTMLInputElement>(`input[name="code-font"][value="${font.id}"]`)!
          .click();
        await until(() => localStorage.getItem(CODE_FONT_STORAGE_KEY) === font.id);
        for (const family of font.family.split(', ')) {
          const faces = await document.fonts.load(`16px ${family}`, 'Hello 中文，标点');
          check(
            faces.length > 0 && faces.every((face) => face.status === 'loaded'),
            `Bundled font failed to load: ${family}`,
          );
        }
        for (const element of [source, document.querySelector('.ProseMirror pre code')!]) {
          check(
            getComputedStyle(element).fontFamily.startsWith(font.family),
            `Preset not applied: ${font.label}`,
          );
        }
        check(
          getComputedStyle(document.querySelector('.ProseMirror')!).fontFamily === bodyFont,
          'Code choice changed prose typography',
        );
        check(source.value === before, 'Changing fonts modified the source draft');
      }
      return `${testCase}: all six offline code-pair faces loaded; independent presets persisted without editing content`;
    }
    click('button[aria-label="切换主题,当前为浅色"]');
    await until(() => document.documentElement.dataset.theme === 'dark' && ready());
    click('button[aria-label="切换主题,当前为深色"]');
    await until(() => document.documentElement.dataset.theme === 'light' && ready());
    await document.fonts.ready;
    await settleAnimations();
    const frame = document.querySelector<HTMLImageElement>('.md-mermaid-holder img')!;
    const scroller = document.querySelector<HTMLElement>('.milkdown-container')!;
    document.querySelector<HTMLElement>('.editor-area')!.style.setProperty('--editor-zoom', '1.2');
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    scroller.scrollTop = 700;
    const top = scroller.scrollTop;
    const box = frame.getBoundingClientRect();
    if (testCase === 'theme-system-light') {
      click('button[aria-label="切换主题,当前为跟随系统"]');
      await until(() => document.querySelector('button[aria-label="切换主题,当前为浅色"]'));
      check(
        !document.querySelector('.md-mermaid-node.loading'),
        'System-light to light unnecessarily rerenders Mermaid',
      );
      check(
        document.querySelector('.md-mermaid-holder img') === frame,
        'Unchanged resolved theme replaced the diagram',
      );
      check(scroller.scrollTop === top, 'Unchanged resolved theme moved the scroll position');
      const after = frame.getBoundingClientRect();
      check(
        after.top === box.top && after.height === box.height && after.width === box.width,
        `Unchanged resolved theme moved or resized the diagram at 120% zoom: ${JSON.stringify(box.toJSON())} => ${JSON.stringify(after.toJSON())}`,
      );
    } else {
      dark = true;
      media.dispatchEvent(new Event('change'));
      await until(() => document.documentElement.dataset.theme === 'dark');
      await until(ready);
      check(
        document.querySelector('.md-mermaid-holder img') !== frame,
        'System color change kept the old diagram theme',
      );
    }
    return `${testCase}: real App theme control and Mermaid lifecycle passed`;
  } finally {
    restoreMermaid();
    root.unmount();
    host.remove();
    window.matchMedia = nativeMatchMedia;
  }
}
