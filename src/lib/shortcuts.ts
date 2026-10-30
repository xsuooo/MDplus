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

/**
 * 一个动作可以挂多个键位(例如「切换大纲」同时有 Ctrl+Shift+E 和 F11)。
 * 旧版本的 Record<Action, string | null> 由 sanitizeShortcuts 自动迁移:
 * 缺失 → 新默认值;显式 null → 空数组(用户主动解绑)。
 */
export type ShortcutBindings = Record<ShortcutAction, string[]>;

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
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
};

export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
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

// 宿主禁用浏览器加速键后, F5/F12 也可由用户分配;未绑定时不刷新或打开开发工具。
const FUNCTION_KEYS = new Set(Array.from({ length: 12 }, (_, index) => `f${index + 1}`));

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
  const key = normalizeKey(parts[parts.length - 1]);
  if (!key) return null;
  const parsed: ParsedShortcut = { ctrl: false, alt: false, shift: false, meta: false, key };
  for (const raw of parts.slice(0, -1)) {
    const mod = raw.toLowerCase();
    if (mod !== 'ctrl' && mod !== 'alt' && mod !== 'shift' && mod !== 'meta') return null;
    if (parsed[mod]) return null;
    parsed[mod] = true;
  }
  const hasModifier = parsed.ctrl || parsed.alt || parsed.shift || parsed.meta;
  // 裸键只放行白名单里的功能键;其余裸键(a、delete、space…)会劫持正常输入
  if (!hasModifier && !FUNCTION_KEYS.has(key)) return null;
  return parsed;
}

/** 归一化成规范加速器；非法返回 null */
export function canonicalize(binding: string | null): string | null {
  if (binding === null) return null;
  const parsed = parseAccelerator(binding);
  return parsed ? formatAccelerator(parsed) : null;
}

export function isComposingEvent(event: Pick<ShortcutEventLike, 'key' | 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing === true || event.key === 'Process' || event.keyCode === 229;
}

export function shortcutFromEvent(event: ShortcutEventLike): string | null {
  if (isComposingEvent(event) || event.getModifierState?.('AltGraph')) return null;
  const key = normalizeKey(event.key);
  if (!key) return null;
  const parsed: ParsedShortcut = {
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
    key,
  };
  const hasModifier = parsed.ctrl || parsed.alt || parsed.shift || parsed.meta;
  // 与 parseAccelerator 同一套规则:裸 F 键可以录制/触发,裸字母仍然拒绝
  if (!hasModifier && !FUNCTION_KEYS.has(key)) return null;
  return formatAccelerator(parsed);
}

export function createShortcutIndex(bindings: ShortcutBindings): Map<string, ShortcutAction> {
  const index = new Map<string, ShortcutAction>();
  for (const definition of SHORTCUT_DEFINITIONS) {
    for (const raw of bindings[definition.id] ?? []) {
      const accelerator = canonicalize(raw);
      if (accelerator && !index.has(accelerator)) index.set(accelerator, definition.id);
    }
  }
  return index;
}

/** 返回是否消费事件;长按已绑定键仍屏蔽宿主行为,但不重复执行应用动作。 */
export function dispatchShortcut(
  event: ShortcutEventLike & { defaultPrevented: boolean; repeat: boolean; preventDefault: () => void },
  index: ReadonlyMap<string, ShortcutAction>,
  run: (action: ShortcutAction) => void,
): boolean {
  if (event.defaultPrevented) return false;
  const accelerator = shortcutFromEvent(event);
  const action = accelerator ? index.get(accelerator) : undefined;
  if (!action) return false;
  event.preventDefault();
  if (!event.repeat) run(action);
  return true;
}

/** 已知的作用域冲突只提示,不删除用户原有的 Ctrl/Shift/Meta 绑定。 */
export function shortcutWarning(binding: string): string | null {
  const parsed = parseAccelerator(binding);
  if (!parsed) return null;
  if (parsed.meta || (parsed.alt && ['tab', 'escape', 'f4', 'space'].includes(parsed.key))) {
    return '系统可能优先处理此组合键;应用无法保证收到事件。';
  }
  if ((parsed.ctrl && !parsed.alt && ['a', 'c', 'x', 'v', 'z', 'y', 'b', 'i', '=', '-', '0'].includes(parsed.key))
    || (!parsed.ctrl && !parsed.alt && parsed.shift && !FUNCTION_KEYS.has(parsed.key))) {
    return '此键位与文本编辑或缩放重叠;编辑器内可能被优先处理或影响输入。';
  }
  return null;
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
    for (const raw of bindings[def.id] ?? []) {
      const accelerator = canonicalize(raw);
      if (!accelerator) continue;
      const list = owners.get(accelerator);
      if (list) {
        // 同一动作的多个键位不会互相冲突,重复登记同一动作时跳过
        if (!list.includes(def.id)) list.push(def.id);
      } else {
        owners.set(accelerator, [def.id]);
      }
    }
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

/** 单个动作的键位列表去重并保持顺序(规范化之后比较,避免 'Ctrl+S' 与 'ctrl+s' 并存) */
function normalizeBindingList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const canonical = canonicalize(item);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    list.push(canonical);
  }
  return list;
}

/**
 * 把持久化数据归一化成 ShortcutBindings。
 * 迁移语义:字段缺失 → 新默认值;显式 null → 空数组(用户主动解绑);
 * 兼容旧版单字符串值;数组内非法项丢弃、重复项去重。
 */
export function sanitizeShortcuts(value: unknown): ShortcutBindings {
  const source =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const result = {} as ShortcutBindings;
  for (const def of SHORTCUT_DEFINITIONS) {
    const fallback = [...DEFAULT_SHORTCUTS[def.id]];
    if (!source || !(def.id in source)) {
      result[def.id] = fallback;
      continue;
    }
    const raw = source[def.id];
    if (raw === null) {
      result[def.id] = [];
      continue;
    }
    if (typeof raw === 'string') {
      const canonical = canonicalize(raw);
      result[def.id] = canonical ? [canonical] : fallback;
      continue;
    }
    const list = normalizeBindingList(raw);
    if (list === null) {
      result[def.id] = fallback;
      continue;
    }
    // 空数组是合法的「显式解绑」;非空却全被丢弃则视为脏数据,回退默认
    const emptyArray = Array.isArray(raw) && raw.length === 0;
    result[def.id] = emptyArray || list.length > 0 ? list : fallback;
  }
  // 旧字符串配置补充新功能键,但保留自定义组合键、显式解绑与其它动作的占用。
  // 数组表示已经迁移过,用户移除的功能键不能在下次启动时重新出现。
  for (const def of SHORTCUT_DEFINITIONS) {
    const raw = source?.[def.id];
    const explicit = typeof raw === 'string' ? [canonicalize(raw)] : normalizeBindingList(raw) ?? [];
    result[def.id] = result[def.id].filter((binding) =>
      !FUNCTION_KEYS.has(binding) || explicit.includes(binding)
      || !SHORTCUT_DEFINITIONS.some((other) => other.id !== def.id && result[other.id].includes(binding)));
    if (typeof raw !== 'string' || !canonicalize(raw)) continue;
    for (const accelerator of DEFAULT_SHORTCUTS[def.id].filter((key) => FUNCTION_KEYS.has(key))) {
      if (!Object.values(result).some((list) => list.includes(accelerator))) {
        result[def.id].push(accelerator);
      }
    }
  }
  return result;
}

/** 找出除 action 之外已经占用 accelerator 的动作 */
export function findOwners(
  bindings: ShortcutBindings,
  action: ShortcutAction,
  accelerator: string,
): ShortcutAction[] {
  const conflict: ShortcutAction[] = [];
  for (const def of SHORTCUT_DEFINITIONS) {
    if (def.id === action) continue;
    const list = bindings[def.id] ?? [];
    if (list.some((item) => canonicalize(item) === accelerator)) conflict.push(def.id);
  }
  return conflict;
}

/** 追加键位,或只替换指定旧键位;冲突或重复时原样返回。 */
export function applyShortcut(
  bindings: ShortcutBindings,
  action: ShortcutAction,
  accelerator: string | null,
  replacing: string | null = null,
): { bindings: ShortcutBindings; conflict: ShortcutAction[] } {
  const canonical = accelerator === null ? null : canonicalize(accelerator);
  if (accelerator !== null && canonical === null) {
    return { bindings, conflict: [] };
  }
  if (canonical === null) return { bindings, conflict: [] };
  const conflict = findOwners(bindings, action, canonical);
  if (conflict.length > 0) return { bindings, conflict };
  const current = bindings[action] ?? [];
  if (current.some((item) => canonicalize(item) === canonical)) return { bindings, conflict: [] };
  const next = [...current];
  if (replacing === null) {
    next.push(canonical);
  } else {
    const previous = canonicalize(replacing);
    const index = previous ? current.findIndex((item) => canonicalize(item) === previous) : -1;
    if (index < 0) return { bindings, conflict: [] };
    next[index] = canonical;
  }
  return { bindings: { ...bindings, [action]: next }, conflict: [] };
}

/** 从动作的键位列表里移除一个键位;移除最后一个即解绑 */
export function removeShortcut(
  bindings: ShortcutBindings,
  action: ShortcutAction,
  accelerator: string,
): ShortcutBindings {
  const canonical = canonicalize(accelerator);
  if (!canonical) return bindings;
  const current = bindings[action] ?? [];
  const next = current.filter((item) => canonicalize(item) !== canonical);
  if (next.length === current.length) return bindings;
  return { ...bindings, [action]: next };
}
