export type StartupView = 'loading' | 'welcome' | 'editor';

export function startupView(startupResolved: boolean, tabCount: number): StartupView {
  if (!startupResolved) return 'loading';
  return tabCount > 0 ? 'editor' : 'welcome';
}
