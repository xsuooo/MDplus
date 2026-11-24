import { refreshMermaidTheme } from './mermaid';
import { beginThemeFade } from './themeFade';

/** Live colors keep controls editable while diagrams refresh independently. */
export function applyTheme(theme: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;
  beginThemeFade();
  void refreshMermaidTheme().catch((error) => console.warn('图表主题刷新失败', error));
}
