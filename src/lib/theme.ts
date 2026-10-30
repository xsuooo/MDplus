import { refreshMermaidTheme } from './mermaid';

let activeTransition: ViewTransition | undefined;
let requestedTheme: 'light' | 'dark' | undefined;
let generation = 0;

/** Fade a complete scene, instead of interpolating panel and text colors separately. */
export function applyTheme(theme: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (requestedTheme === theme && root.dataset.theme === theme) return;
  requestedTheme = theme;
  const current = ++generation;
  activeTransition?.skipTransition();
  activeTransition = undefined;
  root.classList.remove('theme-transitioning');

  if (root.dataset.theme === theme) return;
  const initialized = root.dataset.theme === 'light' || root.dataset.theme === 'dark';
  const update = async () => {
    if (current !== generation) return;
    root.dataset.theme = theme;
    // Slow or offscreen diagrams must not freeze input while a snapshot is captured.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        refreshMermaidTheme().catch((error) => console.warn('图表主题刷新失败', error)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 200); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  if (!initialized || !document.startViewTransition || document.visibilityState === 'hidden'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    void update();
    return;
  }

  root.classList.add('theme-transitioning');
  const transition = document.startViewTransition(update);
  activeTransition = transition;
  // Rapid toggles can skip a snapshot before ready resolves.
  void transition.ready.catch(() => {});
  const finish = () => {
    if (activeTransition !== transition) return;
    activeTransition = undefined;
    root.classList.remove('theme-transitioning');
  };
  void transition.finished.then(finish, finish);
}
