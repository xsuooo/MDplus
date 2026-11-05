import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StatusBar } from '../src/components/StatusBar';
import type { Tab } from '../src/lib/types';

// The browser-only typography popover is covered by the browser suite, not these status-copy checks.
vi.mock('../src/components/TypographyPanel', () => ({ TypographyPanel: () => null }));

const tab: Tab = {
  id: 'test',
  title: 'same.md',
  path: 'C:/notes/project-b/same.md',
  isNew: false,
  dirty: false,
  externalMtime: 100,
  diskRevision: 'revision',
  externalChanged: false,
  initialContent: '',
  savedContent: '',
  markdown: '',
  stats: { words: 0, chars: 0, lines: 1 },
};
function render(saveState: 'saved' | 'dirty' | 'paused', current = tab) {
  return renderToStaticMarkup(
    <StatusBar
      tab={current}
      saveState={saveState}
      themeMode="light"
      onThemeMode={() => {}}
      sourceMode={false}
      zoom={100}
      onResetZoom={() => {}}
      bodyFont="misans"
      codeFont="jetbrains-sarasa"
      onBodyFont={() => {}}
      onCodeFont={() => {}}
      recoveryStatus="protected"
    />,
  );
}

describe('status feedback', () => {
  it('distinguishes paused automatic saving from a saved document and offers a next step', () => {
    const html = render('paused');
    expect(html).toContain('自动保存已暂停');
    expect(html).toContain('Ctrl+S');
    expect(html).toContain('另存为');
    expect(html).not.toContain('已保存');
    expect(html).toContain('role="status"');
  });
  it('shows the current full file identity rather than only an ambiguous basename', () => {
    expect(render('saved')).toContain('C:/notes/project-b/same.md');
  });
  it('does not equate a protected recovery copy with a formal save', () => {
    const html = render('dirty', { ...tab, dirty: true });
    expect(html).toContain('未保存');
    expect(html).toContain('本机副本已保护');
  });
});
