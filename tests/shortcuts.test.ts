import { describe, expect, it } from 'vitest';
import {
  applyShortcut,
  conflictReport,
  DEFAULT_SHORTCUTS,
  findConflicts,
  formatShortcut,
  matchesShortcut,
  sanitizeShortcuts,
  SHORTCUT_DEFINITIONS,
  shortcutFromEvent,
  type ShortcutAction,
  type ShortcutBindings,
  type ShortcutEventLike,
} from '../src/lib/shortcuts';
import { sanitizeShortcutBindings } from '../src/lib/validation';

function ev(key: string, mods: Partial<Omit<ShortcutEventLike, 'key'>> = {}): ShortcutEventLike {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  };
}

describe('shortcut definitions', () => {
  it('covers every action exactly once with default bindings and no conflicts', () => {
    const ids = SHORTCUT_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(12);

    const defaultKeys = Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[];
    expect(defaultKeys.sort()).toEqual([...ids].sort());

    const values = Object.values(DEFAULT_SHORTCUTS).filter((v): v is string => typeof v === 'string');
    expect(new Set(values).size).toBe(values.length);
    expect(findConflicts(DEFAULT_SHORTCUTS)).toEqual([]);
  });

  it('matches the agreed default table', () => {
    expect(DEFAULT_SHORTCUTS).toEqual({
      new: 'ctrl+n',
      open: 'ctrl+o',
      save: 'ctrl+s',
      saveAs: 'ctrl+shift+s',
      search: 'ctrl+f',
      toggleOutline: 'ctrl+shift+e',
      toggleSource: 'ctrl+shift+m',
      exportHtml: 'ctrl+shift+h',
      exportPdf: 'ctrl+shift+p',
      closeTab: 'ctrl+w',
      nextTab: 'ctrl+tab',
      prevTab: 'ctrl+shift+tab',
    });
  });
});

describe('shortcutFromEvent', () => {
  it('builds accelerators with a fixed modifier order', () => {
    expect(shortcutFromEvent(ev('s', { ctrlKey: true }))).toBe('ctrl+s');
    expect(shortcutFromEvent(ev('S', { ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+s');
    expect(shortcutFromEvent(ev('5', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })))
      .toBe('ctrl+alt+shift+meta+5');
    expect(shortcutFromEvent(ev('X', { metaKey: true }))).toBe('meta+x');
  });

  it('normalizes named keys, space and arrows', () => {
    expect(shortcutFromEvent(ev('Tab', { ctrlKey: true }))).toBe('ctrl+tab');
    expect(shortcutFromEvent(ev('Tab', { ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+tab');
    expect(shortcutFromEvent(ev(' ', { ctrlKey: true }))).toBe('ctrl+space');
    expect(shortcutFromEvent(ev('ArrowUp', { ctrlKey: true }))).toBe('ctrl+arrowup');
    expect(shortcutFromEvent(ev('Escape', { ctrlKey: true }))).toBe('ctrl+escape');
    expect(shortcutFromEvent(ev('Enter', { ctrlKey: true }))).toBe('ctrl+enter');
  });

  it('returns null without any modifier', () => {
    expect(shortcutFromEvent(ev('s'))).toBeNull();
    expect(shortcutFromEvent(ev('Tab'))).toBeNull();
    expect(shortcutFromEvent(ev('7'))).toBeNull();
  });

  it('returns null while an IME composition is running', () => {
    expect(shortcutFromEvent(ev('Process', { ctrlKey: true }))).toBeNull();
    expect(shortcutFromEvent(ev('s', { ctrlKey: true, isComposing: true }))).toBeNull();
    expect(shortcutFromEvent(ev('Process'))).toBeNull();
  });

  it('returns null for unknown keys', () => {
    expect(shortcutFromEvent(ev('Unidentified', { ctrlKey: true }))).toBeNull();
    expect(shortcutFromEvent(ev('Dead', { ctrlKey: true }))).toBeNull();
  });
});

describe('matchesShortcut', () => {
  it('matches only when modifiers are exactly equal', () => {
    expect(matchesShortcut('ctrl+s', ev('s', { ctrlKey: true }))).toBe(true);
    expect(matchesShortcut('ctrl+s', ev('s', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchesShortcut('ctrl+shift+s', ev('s', { ctrlKey: true }))).toBe(false);
    expect(matchesShortcut('ctrl+shift+s', ev('s', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesShortcut('ctrl+s', ev('s', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(matchesShortcut('ctrl+s', ev('s', { metaKey: true }))).toBe(false);
  });

  it('handles tab cycling and unbound or malformed bindings', () => {
    expect(matchesShortcut('ctrl+tab', ev('Tab', { ctrlKey: true }))).toBe(true);
    expect(matchesShortcut('ctrl+shift+tab', ev('Tab', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesShortcut('ctrl+shift+tab', ev('Tab', { ctrlKey: true }))).toBe(false);
    expect(matchesShortcut(null, ev('s', { ctrlKey: true }))).toBe(false);
    expect(matchesShortcut('nonsense', ev('s', { ctrlKey: true }))).toBe(false);
  });

  it('ignores events produced during IME composition', () => {
    expect(matchesShortcut('ctrl+s', ev('s', { ctrlKey: true, isComposing: true }))).toBe(false);
    expect(matchesShortcut('ctrl+s', ev('Process', { ctrlKey: true }))).toBe(false);
  });
});

describe('formatShortcut', () => {
  it('renders readable labels and falls back for unbound entries', () => {
    expect(formatShortcut('ctrl+shift+s')).toBe('Ctrl+Shift+S');
    expect(formatShortcut('ctrl+tab')).toBe('Ctrl+Tab');
    expect(formatShortcut('ctrl+space')).toBe('Ctrl+Space');
    expect(formatShortcut('ctrl+arrowup')).toBe('Ctrl+ArrowUp');
    expect(formatShortcut(null)).toBe('未绑定');
    expect(formatShortcut('ctrl+')).toBe('未绑定');
    expect(formatShortcut('ctrl + s')).toBe('未绑定');
  });
});

describe('findConflicts', () => {
  it('reports the shared accelerator and both actions', () => {
    const bindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS, save: 'ctrl+q', closeTab: 'ctrl+q' };
    expect(findConflicts(bindings)).toEqual([{ accelerator: 'ctrl+q', actions: ['save', 'closeTab'] }]);
  });

  it('ignores unbound entries and reports nothing for a clean table', () => {
    const bindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS, new: null, open: null };
    expect(findConflicts(bindings)).toEqual([]);
  });

  it('detects conflicts across more than two actions', () => {
    const bindings: ShortcutBindings = {
      ...DEFAULT_SHORTCUTS,
      new: 'ctrl+k',
      open: 'ctrl+k',
      search: 'ctrl+k',
    };
    const conflicts = findConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].accelerator).toBe('ctrl+k');
    expect(conflicts[0].actions).toEqual(['new', 'open', 'search']);
  });
});

describe('sanitizeShortcuts', () => {
  it('falls back to the full default table for non-object values', () => {
    for (const broken of [undefined, null, 42, 'ctrl+s', true, [], ['ctrl+s']]) {
      expect(sanitizeShortcuts(broken)).toEqual(DEFAULT_SHORTCUTS);
    }
  });

  it('fills missing actions with defaults and keeps null as unbound', () => {
    const result = sanitizeShortcuts({ save: 'ctrl+q', new: null });
    expect(result.save).toBe('ctrl+q');
    expect(result.new).toBeNull();
    expect(result.open).toBe(DEFAULT_SHORTCUTS.open);
    expect(result.prevTab).toBe(DEFAULT_SHORTCUTS.prevTab);
  });

  it('ignores unknown actions', () => {
    const result = sanitizeShortcuts({ save: 'ctrl+q', bogus: 'ctrl+z' });
    expect(result).toEqual({ ...DEFAULT_SHORTCUTS, save: 'ctrl+q' });
  });

  it('rejects non-string values, whitespace, unknown keys and duplicate modifiers', () => {
    const result = sanitizeShortcuts({
      new: 42,
      open: {},
      save: ' ctrl+q',
      saveAs: 'ctrl+ ',
      search: 'ctrl+unknownkey',
      toggleOutline: 'ctrl+ctrl+e',
      toggleSource: 'shift+ctrl+ctrl+m',
      exportHtml: 'hello',
      exportPdf: 'ctrl+',
    });
    for (const id of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
      expect(result[id]).toBe(DEFAULT_SHORTCUTS[id]);
    }
  });

  it('canonicalizes accepted values', () => {
    const result = sanitizeShortcuts({ save: 'Ctrl+Shift+S' });
    expect(result.save).toBe('ctrl+shift+s');
  });

  it('is reachable through validation.sanitizeShortcutBindings', () => {
    expect(sanitizeShortcutBindings({ save: 'ctrl+q' })).toEqual({ ...DEFAULT_SHORTCUTS, save: 'ctrl+q' });
    expect(sanitizeShortcutBindings('nope')).toEqual(DEFAULT_SHORTCUTS);
  });
});

describe('applyShortcut', () => {
  it('rebinds an action and keeps other bindings intact', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'ctrl+q');
    expect(result.conflict).toEqual([]);
    expect(result.bindings.save).toBe('ctrl+q');
    expect(result.bindings.open).toBe(DEFAULT_SHORTCUTS.open);
    expect(DEFAULT_SHORTCUTS.save).toBe('ctrl+s');
  });

  it('canonicalizes the stored accelerator', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'Ctrl+Shift+Q');
    expect(result.bindings.save).toBe('ctrl+shift+q');
  });

  it('refuses an accelerator already used by another action', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'ctrl+shift+s');
    expect(result.conflict).toEqual(['saveAs']);
    expect(result.bindings).toBe(DEFAULT_SHORTCUTS);
  });

  it('clears a binding when null is passed', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', null);
    expect(result.conflict).toEqual([]);
    expect(result.bindings.save).toBeNull();
  });

  it('allows two actions to share an unbound state', () => {
    const first = applyShortcut(DEFAULT_SHORTCUTS, 'save', null);
    const second = applyShortcut(first.bindings, 'saveAs', null);
    expect(second.conflict).toEqual([]);
    expect(second.bindings.save).toBeNull();
    expect(second.bindings.saveAs).toBeNull();
  });

  it('treats a malformed accelerator as not applied', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'ctrl+');
    expect(result.conflict).toEqual([]);
    expect(result.bindings).toBe(DEFAULT_SHORTCUTS);
  });
});

describe('conflictReport', () => {
  it('reports nothing for a clean configuration', () => {
    expect(conflictReport(DEFAULT_SHORTCUTS)).toEqual([]);
  });

  it('marks the first definition as active and the rest as ignored', () => {
    const bindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS, open: 'ctrl+n' };
    expect(conflictReport(bindings)).toEqual([
      { accelerator: 'ctrl+n', active: 'new', ignored: ['open'] },
    ]);
  });

  it('keeps definition order for three-way duplicates and ignores unbound entries', () => {
    const bindings: ShortcutBindings = {
      ...DEFAULT_SHORTCUTS,
      save: 'ctrl+n',
      saveAs: 'ctrl+n',
      search: null,
    };
    const report = conflictReport(bindings);
    expect(report).toHaveLength(1);
    expect(report[0]?.accelerator).toBe('ctrl+n');
    expect(report[0]?.active).toBe('new');
    expect(report[0]?.ignored).toEqual(['save', 'saveAs']);
  });

  it('returns to a clean report once the duplicate is cleared', () => {
    const duplicated: ShortcutBindings = { ...DEFAULT_SHORTCUTS, open: 'ctrl+n' };
    expect(conflictReport(duplicated)).toHaveLength(1);
    expect(conflictReport({ ...duplicated, open: null })).toEqual([]);
    expect(conflictReport({ ...duplicated, open: 'ctrl+alt+o' })).toEqual([]);
  });
});
