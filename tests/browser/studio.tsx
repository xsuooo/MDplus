import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { APPEARANCES, APPEARANCE_STORAGE_KEY } from '../../src/lib/appearance';
import { EDITOR_ZOOM_STORAGE_KEY } from '../../src/lib/editorZoom';
import { createNativeMocks } from './nativeMocks';

export const studioCases = [
  'studio-style-switch',
  'studio-material-contrast',
  'studio-spring-motion',
  'studio-reduced-motion',
  'studio-layout-1920-1080',
  'studio-layout-1440-900',
  'studio-layout-1280-800',
  'studio-layout-1024-768',
  'studio-layout-800-600',
  'studio-layout-390-844',
  'studio-layout-320-640',
] as const;
export type StudioCase = (typeof studioCases)[number];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => unknown) {
  const end = performance.now() + 20000;
  while (!condition()) {
    check(performance.now() < end, 'Studio regression timed out');
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
function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector);
  check(element && !element.disabled, `Missing enabled control: ${selector}`);
  element.click();
}
function inViewport(element: Element, label: string) {
  const box = element.getBoundingClientRect();
  check(
    box.width > 0 &&
      box.height > 0 &&
      box.left >= -1 &&
      box.top >= -1 &&
      box.right <= innerWidth + 1 &&
      box.bottom <= innerHeight + 1,
    `${label} leaves the viewport: ${JSON.stringify(box.toJSON())}`,
  );
}
async function chooseMaterial(id: string, name: string) {
  if (!document.querySelector('.typography-panel')) click('button[aria-label="排版设置"]');
  await until(() => document.querySelector('.appearance-options'));
  click(`button[aria-label="视觉风格：${name}"]`);
  await until(() => document.documentElement.dataset.appearance === id);
  check(
    document
      .querySelector(`button[aria-label="视觉风格：${name}"]`)
      ?.getAttribute('aria-pressed') === 'true',
    'Selected material is not announced',
  );
}
async function colorMode(mode: 'light' | 'dark') {
  for (let attempt = 0; attempt < 3 && document.documentElement.dataset.theme !== mode; attempt++) {
    click('button[aria-label^="切换主题,当前为"]');
    await frame();
    await frame();
  }
  await until(() => document.documentElement.dataset.theme === mode);
  await settle();
}
function luminance(color: string) {
  const values = color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  check(values?.length === 3, `Expected resolved RGB color: ${color}`);
  const linear = values.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(foreground: string, background: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export async function runStudioRegression(testCase: StudioCase): Promise<string> {
  localStorage.setItem(APPEARANCE_STORAGE_KEY, 'folio');
  localStorage.removeItem(EDITOR_ZOOM_STORAGE_KEY);
  const native = createNativeMocks({
    settings: new Map<string, unknown>([
      ['theme-mode', 'light'],
      ['outline-open', false],
      ['session-restore-enabled', false],
    ]),
  });
  native.install();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(<App />);
  try {
    await until(
      () =>
        document.querySelector('.welcome-studio') &&
        document.querySelector('.app')?.getAttribute('data-starting') === 'false',
    );
    await document.fonts.ready;
    await settle();

    if (testCase === 'studio-style-switch') {
      click('.welcome .btn-primary');
      await until(() => document.querySelector('.editor-tab.active .ProseMirror'));
      const rich = document.querySelector('.editor-tab.active .ProseMirror');
      click('button[aria-label="切换 Markdown 模式"]');
      await until(() => document.querySelector('.source-editor:not([hidden]) textarea'));
      const source = document.querySelector<HTMLTextAreaElement>(
        '.source-editor:not([hidden]) textarea',
      )!;
      const text = '# 未保存的想法\n\n' + '显示风格不应改变文字、选择或阅读位置。\n\n'.repeat(70);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        source,
        text,
      );
      source.dispatchEvent(new Event('input', { bubbles: true }));
      // App batches document counters; freeze the baseline after that update, not after one frame.
      await until(
        () =>
          parseInt(document.querySelector('.status-metric-chars')?.textContent ?? '0', 10) > 1000,
      );
      source.setSelectionRange(5, 9);
      source.scrollTop = 200;
      const scroll = source.scrollTop;
      const metrics = document.querySelector('.status-metrics')!.textContent;
      const themeWrites = native.calls.filter((call) => call.command === 'save_settings').length;
      for (const material of APPEARANCES) {
        await chooseMaterial(material.id, material.name);
        await settle();
        check(
          document.querySelector('.source-editor:not([hidden]) textarea') === source,
          'Style switch remounted source editor',
        );
        check(
          document.querySelector('.editor-tab.active .ProseMirror') === rich,
          'Style switch remounted rich editor',
        );
        check(
          source.value === text &&
            source.selectionStart === 5 &&
            source.selectionEnd === 9 &&
            source.scrollTop === scroll,
          'Style switch changed content, selection or position',
        );
        check(
          document.querySelector('.status-metrics')!.textContent === metrics,
          'Style switch changed document statistics',
        );
        check(
          localStorage.getItem(APPEARANCE_STORAGE_KEY) === material.id,
          'Style choice was not persisted',
        );
      }
      check(
        native.calls.filter((call) => call.command === 'save_settings').length === themeWrites,
        'Display-only choice wrote native settings',
      );
      check(
        document.documentElement.dataset.theme === 'light',
        'Material choice changed color mode',
      );
      return `${testCase}: all three materials preserve editor identity, text, selection, scroll, statistics and native preferences`;
    }

    if (testCase === 'studio-spring-motion' || testCase === 'studio-reduced-motion') {
      const scene = document.querySelector<HTMLElement>('.writing-scene')!;
      const box = scene.getBoundingClientRect();
      const before = scene.style.getPropertyValue('--scene-x');
      scene.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: box.right - 10,
          clientY: box.top + 40,
          pointerType: 'mouse',
        }),
      );
      if (testCase === 'studio-reduced-motion') {
        check(
          matchMedia('(prefers-reduced-motion: reduce)').matches,
          'Runner must emulate reduced motion',
        );
        await frame();
        await frame();
        check(
          !scene.classList.contains('scene-in-motion') &&
            scene.style.getPropertyValue('--scene-x') === before,
          'Reduced motion still runs the pointer spring',
        );
        check(
          !document.querySelector('.welcome')!.getAnimations({ subtree: true }).length,
          'Reduced-motion welcome still has active animations',
        );
      } else {
        await until(() => scene.style.getPropertyValue('--scene-x') !== before);
        await until(() => !scene.classList.contains('scene-in-motion'));
        const x = Number(scene.style.getPropertyValue('--scene-x'));
        check(x > 0 && x <= 1, 'Camera spring failed to settle on its bounded target');
        scene.dispatchEvent(new PointerEvent('pointerleave'));
        await until(() => !scene.classList.contains('scene-in-motion'));
        check(
          Number(scene.style.getPropertyValue('--scene-x')) === 0,
          'Scene did not return to neutral',
        );
      }
      return `${testCase}: bounded motion, idle settlement and system preference passed`;
    }

    const layout = testCase.match(/^studio-layout-(\d+)-(\d+)$/);
    if (layout)
      check(
        innerWidth === Number(layout[1]) && innerHeight === Number(layout[2]),
        'Runner viewport does not match the layout case',
      );
    for (const material of APPEARANCES) {
      await chooseMaterial(material.id, material.name);
      click('button[aria-label="关闭排版设置"]');
      await until(() => !document.querySelector('.typography-panel'));
      for (const mode of ['light', 'dark'] as const) {
        await colorMode(mode);
        const surface = getComputedStyle(document.querySelector('.editor-area')!).backgroundColor;
        const primary = document.querySelector<HTMLElement>('.welcome .btn-primary')!;
        const primaryStyle = getComputedStyle(primary);
        check(
          contrast(primaryStyle.color, primaryStyle.backgroundColor) >= 4.5,
          `${material.id}/${mode} primary contrast is below AA`,
        );
        for (const selector of ['.welcome h1', '.welcome h1 > span', '.welcome-description']) {
          const element = document.querySelector(selector)!;
          check(
            contrast(getComputedStyle(element).color, surface) >= 4.5,
            `${material.id}/${mode} ${selector} contrast is below AA`,
          );
        }
        if (layout) {
          check(
            document.documentElement.scrollWidth <= innerWidth,
            'Workspace has horizontal overflow',
          );
          const title = document.querySelector<HTMLElement>('.welcome h1')!;
          check(title.scrollWidth <= title.clientWidth + 1, 'Welcome headline is clipped');
          const scene = document.querySelector('.writing-scene')!;
          if (getComputedStyle(scene).display !== 'none') inViewport(scene, 'Writing sculpture');
          for (const control of document.querySelectorAll(
            '.welcome button, .toolbar button, .statusbar button',
          )) {
            if (control.getBoundingClientRect().width)
              inViewport(
                control,
                control.getAttribute('aria-label') ?? control.textContent ?? 'Control',
              );
          }
          click('button[aria-label="排版设置"]');
          await until(() => document.querySelector('.typography-panel'));
          await settle();
          for (const selector of [
            '.typography-panel',
            '.typography-head',
            '.typography-footer',
            '.appearance-options',
          ])
            inViewport(document.querySelector(selector)!, selector);
          const settings = document.querySelector<HTMLElement>('.typography-content')!;
          check(
            settings.scrollWidth <= settings.clientWidth,
            'Appearance settings overflow horizontally',
          );
          click('button[aria-label="关闭排版设置"]');
          await until(() => !document.querySelector('.typography-panel'));
        }
      }
    }
    if (layout) {
      click('button[aria-label="更多文件操作"]');
      await until(() => document.querySelector('.toolbar-dropdown-menu'));
      await settle();
      const menu = document.querySelector('.toolbar-dropdown-menu')!;
      inViewport(menu, 'More file actions');
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await until(() => !document.querySelector('.toolbar-dropdown-menu'));
      check(
        document.activeElement === document.querySelector('button[aria-label="更多文件操作"]'),
        'More menu did not restore trigger focus',
      );
    }
    return `${testCase}: all six material/color combinations pass AA${layout ? ', welcome geometry, actionable controls, settings and menu bounds' : ''}`;
  } finally {
    root.unmount();
    host.remove();
    localStorage.removeItem(APPEARANCE_STORAGE_KEY);
  }
}
