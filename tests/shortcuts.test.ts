import { describe, expect, it, vi } from 'vitest';
import {
  applyShortcut,
  canonicalize,
  conflictReport,
  createShortcutIndex,
  dispatchShortcut,
  DEFAULT_SHORTCUTS,
  findConflicts,
  findOwners,
  formatShortcut,
  matchesShortcut,
  removeShortcut,
  sanitizeShortcuts,
  SHORTCUT_DEFINITIONS,
  shortcutFromEvent,
  shortcutWarning,
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

    const values = Object.values(DEFAULT_SHORTCUTS).flat();
    expect(new Set(values).size).toBe(values.length);
    expect(findConflicts(DEFAULT_SHORTCUTS)).toEqual([]);
  });

  it('matches the agreed default table', () => {
    expect(DEFAULT_SHORTCUTS).toEqual({
      new: ['ctrl+n'],
      open: ['ctrl+o'],
      save: ['ctrl+s'],
      saveAs: ['ctrl+shift+s'],
      search: ['ctrl+f'],
      toggleOutline: ['ctrl+shift+e', 'f11'],
      toggleSource: ['ctrl+shift+m', 'f2'],
      exportHtml: ['ctrl+shift+h'],
      exportPdf: ['ctrl+shift+p'],
      closeTab: ['ctrl+w'],
      nextTab: ['ctrl+tab'],
      prevTab: ['ctrl+shift+tab'],
    });
  });

  it('keeps the legacy Ctrl/Shift accelerators untouched', () => {
    // 回归护栏:改造功能键不得动到原有键位
    expect(DEFAULT_SHORTCUTS.toggleOutline).toContain('ctrl+shift+e');
    expect(DEFAULT_SHORTCUTS.toggleSource).toContain('ctrl+shift+m');
    expect(DEFAULT_SHORTCUTS.search).toEqual(['ctrl+f']);
    expect(DEFAULT_SHORTCUTS.save).toEqual(['ctrl+s']);
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

  it('accepts bare whitelisted function keys', () => {
    expect(shortcutFromEvent(ev('F11'))).toBe('f11');
    expect(shortcutFromEvent(ev('f11'))).toBe('f11');
    expect(shortcutFromEvent(ev('F2'))).toBe('f2');
    expect(shortcutFromEvent(ev('F1'))).toBe('f1');
    expect(shortcutFromEvent(ev('F10'))).toBe('f10');
  });

  it('accepts every F1-F12 key with or without modifiers', () => {
    for (let number = 1; number <= 12; number++) {
      expect(shortcutFromEvent(ev(`F${number}`))).toBe(`f${number}`);
    }
    // 带修饰键时它们仍然是合法组合
    expect(shortcutFromEvent(ev('F5', { ctrlKey: true }))).toBe('ctrl+f5');
  });

  it('returns null without any modifier for ordinary keys', () => {
    expect(shortcutFromEvent(ev('s'))).toBeNull();
    expect(shortcutFromEvent(ev('Tab'))).toBeNull();
    expect(shortcutFromEvent(ev('7'))).toBeNull();
    expect(shortcutFromEvent(ev('Delete'))).toBeNull();
  });

  it('returns null while an IME composition is running', () => {
    expect(shortcutFromEvent(ev('Process', { ctrlKey: true }))).toBeNull();
    expect(shortcutFromEvent(ev('s', { ctrlKey: true, isComposing: true }))).toBeNull();
    expect(shortcutFromEvent(ev('Process'))).toBeNull();
    expect(shortcutFromEvent(ev('F11', { isComposing: true }))).toBeNull();
    expect(shortcutFromEvent(ev('F11', { keyCode: 229 }))).toBeNull();
  });

  it('protects AltGraph without rejecting ordinary Ctrl+Alt combinations', () => {
    expect(shortcutFromEvent(ev('q', {
      ctrlKey: true, altKey: true, getModifierState: (key) => key === 'AltGraph',
    }))).toBeNull();
    expect(shortcutFromEvent(ev('q', { ctrlKey: true, altKey: true }))).toBe('ctrl+alt+q');
  });

  it('returns null for unknown keys', () => {
    expect(shortcutFromEvent(ev('Unidentified', { ctrlKey: true }))).toBeNull();
    expect(shortcutFromEvent(ev('Dead', { ctrlKey: true }))).toBeNull();
  });
});

describe('canonicalize', () => {
  it('accepts bare function keys and rejects bare ordinary keys', () => {
    expect(canonicalize('f11')).toBe('f11');
    expect(canonicalize('F11')).toBe('f11');
    expect(canonicalize('f2')).toBe('f2');
    expect(canonicalize('f5')).toBe('f5');
    expect(canonicalize('f12')).toBe('f12');
    expect(canonicalize('a')).toBeNull();
    expect(canonicalize('delete')).toBeNull();
    expect(canonicalize(null)).toBeNull();
  });

  it('keeps the modifier requirement for function keys with modifiers', () => {
    expect(canonicalize('ctrl+f11')).toBe('ctrl+f11');
    expect(canonicalize('ctrl+f5')).toBe('ctrl+f5');
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

  it('matches a bare function key binding', () => {
    expect(matchesShortcut('f11', ev('F11'))).toBe(true);
    expect(matchesShortcut('f11', ev('F11', { shiftKey: true }))).toBe(false);
    expect(matchesShortcut('f11', ev('F11', { ctrlKey: true }))).toBe(false);
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
    expect(formatShortcut('f11')).toBe('F11');
    expect(formatShortcut('f2')).toBe('F2');
    expect(formatShortcut(null)).toBe('未绑定');
    expect(formatShortcut('ctrl+')).toBe('未绑定');
    expect(formatShortcut('ctrl + s')).toBe('未绑定');
  });
});

describe('findConflicts', () => {
  it('reports the shared accelerator and both actions', () => {
    const bindings: ShortcutBindings = {
      ...DEFAULT_SHORTCUTS,
      save: ['ctrl+q'],
      closeTab: ['ctrl+q'],
    };
    expect(findConflicts(bindings)).toEqual([{ accelerator: 'ctrl+q', actions: ['save', 'closeTab'] }]);
  });

  it('ignores unbound entries and reports nothing for a clean table', () => {
    const bindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS, new: [], open: [] };
    expect(findConflicts(bindings)).toEqual([]);
  });

  it('detects conflicts across more than two actions', () => {
    const bindings: ShortcutBindings = {
      ...DEFAULT_SHORTCUTS,
      new: ['ctrl+k'],
      open: ['ctrl+k'],
      search: ['ctrl+k'],
    };
    const conflicts = findConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].accelerator).toBe('ctrl+k');
    expect(conflicts[0].actions).toEqual(['new', 'open', 'search']);
  });

  it('detects a conflict on a secondary binding of the same action', () => {
    const bindings: ShortcutBindings = {
      ...DEFAULT_SHORTCUTS,
      save: ['ctrl+s', 'f11'],
    };
    expect(findConflicts(bindings)).toEqual([{ accelerator: 'f11', actions: ['save', 'toggleOutline'] }]);
  });

  it('does not treat two bindings of one action as a conflict', () => {
    const bindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS, save: ['ctrl+s', 'ctrl+shift+q'] };
    expect(findConflicts(bindings)).toEqual([]);
  });
});

describe('sanitizeShortcuts', () => {
  it('falls back to the full default table for non-object values', () => {
    for (const broken of [undefined, null, 42, 'ctrl+s', true, [], ['ctrl+s']]) {
      expect(sanitizeShortcuts(broken)).toEqual(DEFAULT_SHORTCUTS);
    }
  });

  it('fills missing actions with defaults and keeps an explicit null as unbound', () => {
    const result = sanitizeShortcuts({ save: ['ctrl+q'], new: null });
    expect(result.save).toEqual(['ctrl+q']);
    expect(result.new).toEqual([]);
    expect(result.open).toEqual(DEFAULT_SHORTCUTS.open);
    expect(result.prevTab).toEqual(DEFAULT_SHORTCUTS.prevTab);
  });

  it('migrates the legacy single-string format', () => {
    const result = sanitizeShortcuts({ save: 'ctrl+q', new: 'f11' });
    expect(result.save).toEqual(['ctrl+q']);
    expect(result.new).toEqual(['f11']);
  });

  it('keeps an empty array as a deliberate unbind', () => {
    const result = sanitizeShortcuts({ save: [], toggleOutline: [] });
    expect(result.save).toEqual([]);
    expect(result.toggleOutline).toEqual([]);
  });

  it('adds function keys to legacy defaults and custom chords without replacing them', () => {
    const result = sanitizeShortcuts({ toggleOutline: 'meta+e', toggleSource: 'ctrl+shift+m' });
    expect(result.toggleOutline).toEqual(['meta+e', 'f11']);
    expect(result.toggleSource).toEqual(['ctrl+shift+m', 'f2']);
    expect(sanitizeShortcuts(result)).toEqual(result);
  });

  it('does not re-add a removed key, override an unbind or steal an existing function key', () => {
    expect(sanitizeShortcuts({ toggleOutline: ['meta+e'] }).toggleOutline).toEqual(['meta+e']);
    expect(sanitizeShortcuts({ toggleOutline: null }).toggleOutline).toEqual([]);
    const result = sanitizeShortcuts({ toggleOutline: 'ctrl+shift+e', save: ['f11'] });
    expect(result.toggleOutline).toEqual(['ctrl+shift+e']);
    expect(result.save).toEqual(['f11']);
    expect(findConflicts(result)).toEqual([]);
    const missingOutline = sanitizeShortcuts({ closeTab: ['f11'] });
    expect(missingOutline.toggleOutline).toEqual(['ctrl+shift+e']);
    expect(missingOutline.closeTab).toEqual(['f11']);
    expect(findConflicts(missingOutline)).toEqual([]);
  });

  it('deduplicates and canonicalizes array entries', () => {
    const result = sanitizeShortcuts({ save: ['Ctrl+S', 'ctrl+s', 'f11', 'F11'] });
    expect(result.save).toEqual(['ctrl+s', 'f11']);
  });

  it('ignores unknown actions', () => {
    const result = sanitizeShortcuts({ save: ['ctrl+q'], bogus: ['ctrl+z'] });
    expect(result).toEqual({ ...DEFAULT_SHORTCUTS, save: ['ctrl+q'] });
  });

  it('rejects non-string values, whitespace, unknown keys and duplicate modifiers', () => {
    const result = sanitizeShortcuts({
      new: 42,
      open: {},
      save: [' ctrl+q'],
      saveAs: ['ctrl+ '],
      search: ['ctrl+unknownkey'],
      toggleOutline: ['ctrl+ctrl+e'],
      toggleSource: ['shift+ctrl+ctrl+m'],
      exportHtml: ['hello'],
      exportPdf: ['ctrl+'],
    });
    for (const id of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
      expect(result[id]).toEqual(DEFAULT_SHORTCUTS[id]);
    }
  });

  it('canonicalizes accepted values', () => {
    const result = sanitizeShortcuts({ save: ['Ctrl+Shift+S'] });
    expect(result.save).toEqual(['ctrl+shift+s']);
  });

  it('is reachable through validation.sanitizeShortcutBindings', () => {
    expect(sanitizeShortcutBindings({ save: ['ctrl+q'] })).toEqual({
      ...DEFAULT_SHORTCUTS,
      save: ['ctrl+q'],
    });
    expect(sanitizeShortcutBindings('nope')).toEqual(DEFAULT_SHORTCUTS);
  });
});

describe('findOwners', () => {
  it('lists the other actions already using an accelerator', () => {
    expect(findOwners(DEFAULT_SHORTCUTS, 'save', 'ctrl+shift+s')).toEqual(['saveAs']);
    expect(findOwners(DEFAULT_SHORTCUTS, 'save', 'ctrl+q')).toEqual([]);
  });

  it('finds owners behind a secondary binding', () => {
    expect(findOwners(DEFAULT_SHORTCUTS, 'save', 'f11')).toEqual(['toggleOutline']);
  });
});

describe('applyShortcut', () => {
  it('appends a new binding and keeps the existing ones', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'ctrl+q');
    expect(result.conflict).toEqual([]);
    expect(result.bindings.save).toEqual(['ctrl+s', 'ctrl+q']);
    expect(result.bindings.open).toEqual(DEFAULT_SHORTCUTS.open);
    expect(DEFAULT_SHORTCUTS.save).toEqual(['ctrl+s']);
  });

  it('adds a bare function key as a second binding', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'toggleOutline', 'f4');
    expect(result.conflict).toEqual([]);
    expect(result.bindings.toggleOutline).toEqual(['ctrl+shift+e', 'f11', 'f4']);
  });

  it.each([
    ['ctrl+shift+e', ['f4', 'f11']],
    ['f11', ['ctrl+shift+e', 'f4']],
  ])('replaces only %s while retaining the other outline binding', (replacing, expected) => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'toggleOutline', 'f4', replacing);
    expect(result.conflict).toEqual([]);
    expect(result.bindings.toggleOutline).toEqual(expected);
    expect(result.bindings.save).toEqual(DEFAULT_SHORTCUTS.save);
    expect(DEFAULT_SHORTCUTS.toggleOutline).toEqual(['ctrl+shift+e', 'f11']);
  });

  it('canonicalizes both the replacement and the selected old binding', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'Ctrl+Q', 'CTRL+S');
    expect(result.bindings.save).toEqual(['ctrl+q']);
  });

  it('retains the original binding when its replacement belongs to another action', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'f11', 'ctrl+s');
    expect(result.conflict).toEqual(['toggleOutline']);
    expect(result.bindings).toBe(DEFAULT_SHORTCUTS);
  });

  it.each(['F11', 'ctrl+shift+e'])('does not remove an alias or duplicate %s already on this action', (key) => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'toggleOutline', key, 'ctrl+shift+e');
    expect(result.bindings).toBe(DEFAULT_SHORTCUTS);
  });

  it.each(['ctrl+q', 'Fn'])('never appends when the replacement target is missing or invalid: %s', (old) => {
    expect(applyShortcut(DEFAULT_SHORTCUTS, 'save', 'f4', old).bindings).toBe(DEFAULT_SHORTCUTS);
  });

  it('leaves the original binding intact for an invalid replacement', () => {
    expect(applyShortcut(DEFAULT_SHORTCUTS, 'save', 'Fn', 'ctrl+s').bindings).toBe(DEFAULT_SHORTCUTS);
  });

  it('canonicalizes the stored accelerator', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'Ctrl+Shift+Q');
    expect(result.bindings.save).toEqual(['ctrl+s', 'ctrl+shift+q']);
  });

  it('does not duplicate an already bound accelerator', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'CTRL+S');
    expect(result.conflict).toEqual([]);
    expect(result.bindings).toBe(DEFAULT_SHORTCUTS);
  });

  it('refuses an accelerator already used by another action', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'ctrl+shift+s');
    expect(result.conflict).toEqual(['saveAs']);
    expect(result.bindings).toBe(DEFAULT_SHORTCUTS);
  });

  it('refuses a bare function key owned by another action', () => {
    const result = applyShortcut(DEFAULT_SHORTCUTS, 'save', 'f11');
    expect(result.conflict).toEqual(['toggleOutline']);
    expect(result.bindings).toBe(DEFAULT_SHORTCUTS);
  });

  it('leaves bindings untouched for null or malformed input', () => {
    expect(applyShortcut(DEFAULT_SHORTCUTS, 'save', null).bindings).toBe(DEFAULT_SHORTCUTS);
    expect(applyShortcut(DEFAULT_SHORTCUTS, 'save', 'ctrl+').bindings).toBe(DEFAULT_SHORTCUTS);
    expect(applyShortcut(DEFAULT_SHORTCUTS, 'save', 'Fn').bindings).toBe(DEFAULT_SHORTCUTS);
  });
});

describe('dispatchShortcut', () => {
  function event(key: string, extra = {}) {
    return { ...ev(key), defaultPrevented: false, repeat: false, preventDefault: vi.fn(), ...extra };
  }

  it('dispatches every original chord and new alias to its configured action', () => {
    const index = createShortcutIndex(DEFAULT_SHORTCUTS);
    for (const [action, bindings] of Object.entries(DEFAULT_SHORTCUTS)) {
      for (const binding of bindings) {
        const parts = binding.split('+');
        const key = parts.pop()!;
        const run = vi.fn();
        dispatchShortcut(event(key, {
          ctrlKey: parts.includes('ctrl'), altKey: parts.includes('alt'),
          shiftKey: parts.includes('shift'), metaKey: parts.includes('meta'),
        }), index, run);
        expect(run).toHaveBeenCalledExactlyOnceWith(action);
      }
    }
  });

  it.each([
    ['F11', {}, 'toggleOutline'],
    ['E', { ctrlKey: true, shiftKey: true }, 'toggleOutline'],
    ['F2', {}, 'toggleSource'],
    ['s', { ctrlKey: true }, 'save'],
    ['Tab', { ctrlKey: true, shiftKey: true }, 'prevTab'],
  ] as const)('dispatches %s once through the default index', (key, mods, expected) => {
    const e = event(key, mods);
    const run = vi.fn();
    expect(dispatchShortcut(e, createShortcutIndex(DEFAULT_SHORTCUTS), run)).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith(expected);
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it('keeps custom Ctrl, Shift, Alt and Win/Meta bindings', () => {
    for (const [binding, key, mods] of [
      ['ctrl+q', 'q', { ctrlKey: true }],
      ['shift+f3', 'F3', { shiftKey: true }],
      ['alt+f6', 'F6', { altKey: true }],
      ['meta+e', 'e', { metaKey: true }],
    ] as const) {
      const run = vi.fn();
      dispatchShortcut(event(key, mods), createShortcutIndex({ ...DEFAULT_SHORTCUTS, save: [binding] }), run);
      expect(run).toHaveBeenCalledExactlyOnceWith('save');
    }
  });

  it('consumes autorepeat without toggling again', () => {
    const e = event('F11', { repeat: true });
    const run = vi.fn();
    expect(dispatchShortcut(e, createShortcutIndex(DEFAULT_SHORTCUTS), run)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { defaultPrevented: true }, { isComposing: true }, { keyCode: 229 },
    { getModifierState: () => true }, { shiftKey: true },
  ])('does not consume a protected or nonmatching event: %j', (extra) => {
    const e = event('F11', extra);
    const run = vi.fn();
    expect(dispatchShortcut(e, createShortcutIndex(DEFAULT_SHORTCUTS), run)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('uses the same winner as the conflict report while keeping other aliases active', () => {
    const bindings = { ...DEFAULT_SHORTCUTS, save: ['ctrl+s', 'F11'] };
    const index = createShortcutIndex(bindings);
    expect(index.get('f11')).toBe(conflictReport(bindings)[0].active);
    expect(index.get('ctrl+shift+e')).toBe('toggleOutline');
  });

  it('does not consume ordinary typing or an unbound function key', () => {
    for (const key of ['a', 'Delete', 'F12', 'Fn', 'AudioVolumeUp']) {
      const e = event(key);
      expect(dispatchShortcut(e, createShortcutIndex(DEFAULT_SHORTCUTS), vi.fn())).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe('shortcutWarning', () => {
  it('distinguishes known system and editing conflicts from available function keys', () => {
    expect(shortcutWarning('meta+l')).toContain('系统');
    expect(shortcutWarning('alt+f4')).toContain('系统');
    expect(shortcutWarning('ctrl+z')).toContain('文本编辑');
    expect(shortcutWarning('shift+a')).toContain('文本编辑');
    expect(shortcutWarning('f11')).toBeNull();
    expect(shortcutWarning('ctrl+shift+e')).toBeNull();
  });
});

describe('removeShortcut', () => {
  it('drops one binding and keeps the rest', () => {
    const result = removeShortcut(DEFAULT_SHORTCUTS, 'toggleOutline', 'f11');
    expect(result.toggleOutline).toEqual(['ctrl+shift+e']);
    expect(DEFAULT_SHORTCUTS.toggleOutline).toEqual(['ctrl+shift+e', 'f11']);
  });

  it('unbinds the action when the last binding is removed', () => {
    const result = removeShortcut(DEFAULT_SHORTCUTS, 'save', 'ctrl+s');
    expect(result.save).toEqual([]);
    expect(findConflicts(result)).toEqual([]);
  });

  it('canonicalizes before comparing and is a no-op for unknown bindings', () => {
    expect(removeShortcut(DEFAULT_SHORTCUTS, 'toggleOutline', 'F11').toggleOutline).toEqual([
      'ctrl+shift+e',
    ]);
    expect(removeShortcut(DEFAULT_SHORTCUTS, 'save', 'ctrl+q')).toBe(DEFAULT_SHORTCUTS);
  });
});

describe('conflictReport', () => {
  it('reports nothing for a clean configuration', () => {
    expect(conflictReport(DEFAULT_SHORTCUTS)).toEqual([]);
  });

  it('marks the first definition as active and the rest as ignored', () => {
    const bindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS, open: ['ctrl+n'] };
    expect(conflictReport(bindings)).toEqual([
      { accelerator: 'ctrl+n', active: 'new', ignored: ['open'] },
    ]);
  });

  it('keeps definition order for three-way duplicates and ignores unbound entries', () => {
    const bindings: ShortcutBindings = {
      ...DEFAULT_SHORTCUTS,
      save: ['ctrl+n'],
      saveAs: ['ctrl+n'],
      search: [],
    };
    const report = conflictReport(bindings);
    expect(report).toHaveLength(1);
    expect(report[0]?.accelerator).toBe('ctrl+n');
    expect(report[0]?.active).toBe('new');
    expect(report[0]?.ignored).toEqual(['save', 'saveAs']);
  });

  it('returns to a clean report once the duplicate is cleared', () => {
    const duplicated: ShortcutBindings = { ...DEFAULT_SHORTCUTS, open: ['ctrl+n'] };
    expect(conflictReport(duplicated)).toHaveLength(1);
    expect(conflictReport({ ...duplicated, open: [] })).toEqual([]);
    expect(conflictReport({ ...duplicated, open: ['ctrl+alt+o'] })).toEqual([]);
  });
});
