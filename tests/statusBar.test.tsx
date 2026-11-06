import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StatusBar } from '../src/components/StatusBar';
import type { Tab } from '../src/lib/types';
import type { ComponentProps } from 'react';
import { APP_VERSION_DETAILS, APP_VERSION_LABEL } from '../src/lib/appVersion';

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
type StatusBarProps = ComponentProps<typeof StatusBar>;
function render(
  saveState: StatusBarProps['saveState'],
  current: Tab | null = tab,
  overrides: Partial<StatusBarProps> = {},
) {
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
      {...overrides}
    />,
  );
}

describe('status feedback', () => {
  it('distinguishes paused automatic saving from a saved document and offers a next step', () => {
    const html = render('paused');
    expect(html).toContain('保存已暂停');
    expect(html).toContain('自动保存已暂停');
    expect(html).toContain('Ctrl+S');
    expect(html).toContain('另存为');
    expect(html).not.toContain('已保存');
    expect(html).toContain('role="status"');
  });
  it('shows the current full file identity rather than only an ambiguous basename', () => {
    const html = render('saved');
    expect(html).toContain('title="C:/notes/project-b/same.md"');
    expect(html).toContain('status-file-identity');
  });
  it('does not equate a protected recovery copy with a formal save', () => {
    const html = render('dirty', { ...tab, dirty: true });
    expect(html).toContain('未保存');
    expect(html).toContain('草稿已保护');
    expect(html).toContain('不等于正式保存');
  });
  it('shows one unsaved message and no placeholder path for a new document', () => {
    const html = render('unsaved', { ...tab, path: null, isNew: true });
    expect(html.match(/未保存/g)).toHaveLength(1);
    expect(html).toContain('Ctrl+S');
    expect(html).not.toContain('尚未保存到磁盘');
    expect(html).not.toContain('待另存为');
    expect(html).not.toContain('status-file-identity');
  });
  it('does not describe a document without a disk path as saved', () => {
    const html = render('saved', { ...tab, path: null, isNew: true });
    expect(html).toContain('未保存');
    expect(html).not.toContain('已保存');
  });
  it('keeps draft failures actionable without a redundant healthy protection message', () => {
    expect(render('saved')).not.toContain('草稿已保护');
    const html = render('dirty', tab, { recoveryStatus: 'error' });
    expect(html).toContain('草稿保护失败');
    expect(html).toContain('手动保存');
  });
  it('preserves the version and build identity when no document is open', () => {
    const html = render('idle', null);
    expect(html).toContain(`>${APP_VERSION_LABEL}</span>`);
    expect(html).toContain(`title="${APP_VERSION_DETAILS}"`);
    expect(html).toContain(`aria-label="${APP_VERSION_DETAILS}"`);
    expect(html).toContain('class="statusbar-version"');
    expect(html).not.toContain('status-save-');
  });
});
