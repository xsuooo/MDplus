export type ShortcutAction =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'search'
  | 'toggleOutline'
  | 'toggleSource'
  | 'exportHtml'
  | 'exportPdf'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab';

export interface ShortcutDefinition {
  id: ShortcutAction;
  label: string;
  group: '文件' | '视图' | '标签';
}

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { id: 'new', label: '新建', group: '文件' },
  { id: 'open', label: '打开', group: '文件' },
  { id: 'save', label: '保存', group: '文件' },
  { id: 'saveAs', label: '另存为', group: '文件' },
  { id: 'exportHtml', label: '导出 HTML', group: '文件' },
  { id: 'exportPdf', label: '导出 PDF', group: '文件' },
  { id: 'search', label: '查找', group: '视图' },
  { id: 'toggleOutline', label: '切换大纲', group: '视图' },
  { id: 'toggleSource', label: '切换源码模式', group: '视图' },
  { id: 'closeTab', label: '关闭标签', group: '标签' },
  { id: 'nextTab', label: '下一个标签', group: '标签' },
  { id: 'prevTab', label: '上一个标签', group: '标签' },
];

export type ShortcutBindings = Record<ShortcutAction, string | null>;

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
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
};

export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

interface ParsedShortcut {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const NAMED_KEYS = new Set([
  'tab',
  'escape',
  'enter',
  'space',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
]);

/** '+号会破坏加速器分隔，故不纳入单字符键 */
const SYMBOL_KEYS = new Set([',', '.', '/', '-', '=', '[', ']', ';', "'"]);

const DISPLAY_KEYS: Record<string, string> = {
  tab: 'Tab',
  escape: 'Escape',
  enter: 'Enter',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
};

/** 把 KeyboardEvent.key 归一化成加速器里的键名；未知键返回 null */
function normalizeKey(key: string): string | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (key === ' ') return 'space';
  const lower = key.toLowerCase();
  if (lower.length === 1) {
    if (lower >= 'a' && lower <= 'z') return lower;
    if (lower >= '0' && lower <= '9') return lower;
    return SYMBOL_KEYS.has(lower) ? lower : null;
  }
  return NAMED_KEYS.has(lower) ? lower : null;
}

function formatAccelerator(parsed: ParsedShortcut): string {
  const parts: string[] = [];
  if (parsed.ctrl) parts.push('ctrl');
  if (parsed.alt) parts.push('alt');
  if (parsed.shift) parts.push('shift');
  if (parsed.meta) parts.push('meta');
  parts.push(parsed.key);
  return parts.join('+');
}

/** 解析加速器字符串；格式非法返回 null */
function parseAccelerator(binding: string): ParsedShortcut | null {
  if (typeof binding !== 'string' || binding.length === 0) return null;
  if (/\s/.test(binding)) return null;
  const parts = binding.split('+');
  if (parts.length < 2) return null;
  const key = normalizeKey(parts[parts.length - 1]);
  if (!key) return null;
  const parsed: ParsedShortcut = { ctrl: false, alt: false, shift: false, meta: false, key };
  for (const raw of parts.slice(0, -1)) {
    const mod = raw.toLowerCase();
    if (mod !== 'ctrl' && mod !== 'alt' && mod !== 'shift' && mod !== 'meta') return null;
    if (parsed[mod]) return null;
    parsed[mod] = true;
  }
  if (!parsed.ctrl && !parsed.alt && !parsed.shift && !parsed.meta) return null;
  return parsed;
}

/** 归一化成规范加速器；非法返回 null */
function canonicalize(binding: string | null): string | null {
  if (binding === null) return null;
  const parsed = parseAccelerator(binding);
  return parsed ? formatAccelerator(parsed) : null;
}

function isComposingEvent(event: ShortcutEventLike): boolean {
  return event.isComposing === true || event.key === 'Process';
}

export function shortcutFromEvent(event: ShortcutEventLike): string | null {
  if (isComposingEvent(event)) return null;
  const key = normalizeKey(event.key);
  if (!key) return null;
  const parsed: ParsedShortcut = {
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
    key,
  };
  if (!parsed.ctrl && !parsed.alt && !parsed.shift && !parsed.meta) return null;
  return formatAccelerator(parsed);
}

export function matchesShortcut(binding: string | null, event: ShortcutEventLike): boolean {
  if (binding === null) return false;
  const target = canonicalize(binding);
  if (!target) return false;
  return shortcutFromEvent(event) === target;
}

export function formatShortcut(binding: string | null): string {
  const parsed = binding === null ? null : parseAccelerator(binding);
  if (!parsed) return '未绑定';
  const parts: string[] = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  if (parsed.meta) parts.push('Meta');
  const display = DISPLAY_KEYS[parsed.key] ?? parsed.key.toUpperCase();
  parts.push(display);
  return parts.join('+');
}

export function findConflicts(
  bindings: ShortcutBindings,
): { accelerator: string; actions: ShortcutAction[] }[] {
  const owners = new Map<string, ShortcutAction[]>();
  for (const def of SHORTCUT_DEFINITIONS) {
    const accelerator = canonicalize(bindings[def.id] ?? null);
    if (!accelerator) continue;
    const list = owners.get(accelerator);
    if (list) list.push(def.id);
    else owners.set(accelerator, [def.id]);
  }
  const conflicts: { accelerator: string; actions: ShortcutAction[] }[] = [];
  for (const [accelerator, actions] of owners) {
    if (actions.length > 1) conflicts.push({ accelerator, actions });
  }
  return conflicts;
}

export interface ShortcutConflictReport {
  accelerator: string;
  /** 实际生效的动作:与 App 分发一致,取 SHORTCUT_DEFINITIONS 顺序里的第一个 */
  active: ShortcutAction;
  /** 同一个组合键下不会触发的其余动作 */
  ignored: ShortcutAction[];
}

/** 把 findConflicts 的分组结果标出"谁生效、谁被忽略",供设置面板提示历史脏数据。 */
export function conflictReport(bindings: ShortcutBindings): ShortcutConflictReport[] {
  return findConflicts(bindings).map(({ accelerator, actions }) => ({
    accelerator,
    active: actions[0]!,
    ignored: actions.slice(1),
  }));
}

export function sanitizeShortcuts(value: unknown): ShortcutBindings {
  const source =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const result = {} as ShortcutBindings;
  for (const def of SHORTCUT_DEFINITIONS) {
    const fallback = DEFAULT_SHORTCUTS[def.id];
    if (!source || !(def.id in source)) {
      result[def.id] = fallback;
      continue;
    }
    const raw = source[def.id];
    if (raw === null) {
      result[def.id] = null;
      continue;
    }
    const canonical = typeof raw === 'string' ? canonicalize(raw) : null;
    result[def.id] = canonical ?? fallback;
  }
  return result;
}

export function applyShortcut(
  bindings: ShortcutBindings,
  action: ShortcutAction,
  accelerator: string | null,
): { bindings: ShortcutBindings; conflict: ShortcutAction[] } {
  const canonical = accelerator === null ? null : canonicalize(accelerator);
  if (accelerator !== null && canonical === null) {
    return { bindings, conflict: [] };
  }
  if (canonical !== null) {
    const conflict: ShortcutAction[] = [];
    for (const def of SHORTCUT_DEFINITIONS) {
      if (def.id === action) continue;
      if (canonicalize(bindings[def.id] ?? null) === canonical) conflict.push(def.id);
    }
    if (conflict.length > 0) return { bindings, conflict };
  }
  if ((bindings[action] ?? null) === canonical) return { bindings, conflict: [] };
  return { bindings: { ...bindings, [action]: canonical }, conflict: [] };
}
