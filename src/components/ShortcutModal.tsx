import { memo, useEffect, useRef, useState } from 'react';
import { useDialogFocus } from '../lib/useDialogFocus';
import {
  SHORTCUT_DEFINITIONS,
  applyShortcut,
  conflictReport,
  formatShortcut,
  isComposingEvent,
  removeShortcut,
  sanitizeShortcuts,
  shortcutFromEvent,
  shortcutWarning,
  type ShortcutAction,
  type ShortcutBindings,
  type ShortcutDefinition,
} from '../lib/shortcuts';

const GROUP_ORDER: ReadonlyArray<ShortcutDefinition['group']> = ['文件', '视图', '标签'];

const ACTION_LABELS = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition.label]),
) as Record<ShortcutAction, string>;

/** 只按下修饰键本身时给出提示,避免面板看起来没反应 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

interface ShortcutModalProps {
  bindings: ShortcutBindings;
  onChange: (bindings: ShortcutBindings) => void;
  onClose: () => void;
}

export const ShortcutModal = memo(function ShortcutModal({ bindings, onChange, onClose }: ShortcutModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const [capturing, setCapturing] = useState<{ action: ShortcutAction; binding: string | null } | null>(null);
  const [conflict, setConflict] = useState<{ action: ShortcutAction; actions: ShortcutAction[] } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  // 捕获期间需要读最新绑定,避免 effect 持有过期闭包
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 输入法组字中:交给输入法,既不录制也不吞键
      if (isComposingEvent(event) || event.getModifierState('AltGraph')) return;
      // 捕获阶段截获:既不让 Esc 走到 useDialogFocus 的关闭逻辑,也不让组合键触发应用动作
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === 'Escape') {
        setCapturing(null);
        setConflict(null);
        setHint(null);
        return;
      }
      const accelerator = shortcutFromEvent(event);
      if (!accelerator) {
        // 明确告诉用户为什么没录上,而不是停在"按下新组合键…"
        setHint(
          MODIFIER_KEYS.has(event.key)
            ? '只按下了修饰键,请再按一个主键。'
            : `「${event.key}」不可录制,请使用 Ctrl / Alt / Shift / Win 组合或 F1–F12。`,
        );
        return;
      }

      const result = applyShortcut(bindingsRef.current, capturing.action, accelerator, capturing.binding);
      if (result.conflict.length > 0) {
        setConflict({ action: capturing.action, actions: result.conflict });
        setHint(null);
        return; // 不应用,保持原绑定
      }
      setConflict(null);
      setHint(shortcutWarning(accelerator));
      setCapturing(null);
      onChange(result.bindings);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, onChange]);

  const startCapture = (action: ShortcutAction, binding: string | null = null) => {
    setConflict(null);
    setHint(null);
    setCapturing((current) => (
      current?.action === action && current.binding === binding ? null : { action, binding }
    ));
  };

  /** 移除单个键位;移除最后一个即解绑 */
  const removeBinding = (action: ShortcutAction, accelerator: string) => {
    setCapturing(null);
    setConflict(null);
    setHint(null);
    onChange(removeShortcut(bindings, action, accelerator));
  };

  const clearBinding = (action: ShortcutAction) => {
    setCapturing(null);
    setConflict(null);
    setHint(null);
    onChange({ ...bindings, [action]: [] });
  };

  const restoreDefaults = () => {
    setCapturing(null);
    setConflict(null);
    setHint(null);
    onChange(sanitizeShortcuts(null));
  };

  // 持久化配置里可能已有重复绑定(手工编辑或旧版本遗留):只提示,不静默改写。
  const duplicateGroups = conflictReport(bindings);
  const ignoredActions = new Set<ShortcutAction>(duplicateGroups.flatMap((group) => group.ignored));

  const conflictText = (action: ShortcutAction): string | null => {
    if (!conflict || conflict.action !== action) return null;
    const labels = conflict.actions.map((other) => `「${ACTION_LABELS[other]}」`).join('、');
    return `已被${labels}占用`;
  };

  return (
    <div className="modal-mask" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal shortcut-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabIndex={-1}
      >
        <h3 id="shortcuts-title">快捷键</h3>
        {hint && (
          <p className="shortcut-hint" role="status">
            {hint}
          </p>
        )}
        {duplicateGroups.length > 0 && (
          <div className="shortcut-duplicate-warning" role="alert">
            <strong>存在重复绑定,部分快捷键不会生效</strong>
            <ul>
              {duplicateGroups.map((group) => (
                <li key={group.accelerator}>
                  {formatShortcut(group.accelerator)} 已由「{ACTION_LABELS[group.active]}」使用,
                  「{group.ignored.map((action) => ACTION_LABELS[action]).join('、')}」不会由此键位触发
                </li>
              ))}
            </ul>
            <span>同一组合键只执行第一个匹配的操作,请清除或修改重复项。</span>
          </div>
        )}
        <div className="shortcut-table-wrap">
          <table className="shortcut-table">
            <thead>
              <tr>
                <th scope="col" aria-label="操作项">操作项</th>
                <th scope="col" aria-label="当前快捷键">当前快捷键</th>
                <th scope="col" aria-label="快捷键操作">操作</th>
              </tr>
            </thead>
            {GROUP_ORDER.map((group) => (
              <tbody key={group}>
                <tr className="shortcut-group-row">
                  <th scope="colgroup" colSpan={3} aria-label={`${group}类快捷键`}>
                    {group}
                  </th>
                </tr>
                {SHORTCUT_DEFINITIONS.filter((definition) => definition.group === group).map((definition) => {
                  const label = ACTION_LABELS[definition.id];
                  const isCapturing = capturing?.action === definition.id;
                  const message = conflictText(definition.id);
                  const list = bindings[definition.id] ?? [];
                  return (
                    <tr key={definition.id} className="shortcut-row">
                      <th scope="row">{label}</th>
                      <td>
                        {list.length === 0 && !isCapturing ? (
                          <kbd className="shortcut-kbd shortcut-kbd-unbound">{formatShortcut(null)}</kbd>
                        ) : (
                          <span className="shortcut-kbd-list">
                            {list.map((accelerator) => (
                              <span className="shortcut-kbd-chip" key={accelerator}>
                                <button
                                  type="button"
                                  className={`shortcut-kbd shortcut-kbd-edit${isCapturing && capturing.binding === accelerator ? ' shortcut-kbd-capturing' : ''}`}
                                  onClick={() => startCapture(definition.id, accelerator)}
                                  aria-label={`修改「${label}」的 ${formatShortcut(accelerator)}`}
                                  aria-pressed={isCapturing && capturing.binding === accelerator}
                                  title="点击修改"
                                >
                                  <kbd>
                                    {isCapturing && capturing.binding === accelerator ? '按下快捷键…' : formatShortcut(accelerator)}
                                  </kbd>
                                </button>
                                <button
                                  type="button"
                                  className="shortcut-kbd-remove"
                                  onClick={() => removeBinding(definition.id, accelerator)}
                                  aria-label={`移除「${label}」的 ${formatShortcut(accelerator)}`}
                                  title="移除这个键位"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                            {isCapturing && capturing.binding === null && (
                              <kbd className="shortcut-kbd shortcut-kbd-capturing">按下快捷键…</kbd>
                            )}
                          </span>
                        )}
                        {isCapturing && (
                          <span className="shortcut-recording-hint" role="status">
                            {capturing.binding === null ? '添加快捷键' : `替换 ${formatShortcut(capturing.binding)}`}，Esc 取消
                          </span>
                        )}
                        {ignoredActions.has(definition.id) && (
                          <span className="shortcut-ignored">存在不生效的键位</span>
                        )}
                        {list.filter((accelerator) => shortcutWarning(accelerator)).map((accelerator) => (
                          <span className="shortcut-hint" key={`warning-${accelerator}`}>
                            {formatShortcut(accelerator)}: {shortcutWarning(accelerator)}
                          </span>
                        ))}
                        {message && (
                          <span className="shortcut-conflict" role="alert">
                            {message}
                          </span>
                        )}
                      </td>
                      <td className="shortcut-actions">
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => {
                            if (isCapturing) {
                              setCapturing(null);
                              setConflict(null);
                              setHint(null);
                            } else {
                              startCapture(definition.id);
                            }
                          }}
                          aria-label={`${isCapturing ? '取消录制' : '添加'}「${label}」快捷键`}
                          aria-pressed={isCapturing}
                        >
                          {isCapturing ? '取消' : '添加'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => clearBinding(definition.id)}
                          aria-label={`清除「${label}」快捷键`}
                          disabled={list.length === 0}
                        >
                          清除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={restoreDefaults} aria-label="恢复默认快捷键">
            恢复默认值
          </button>
          <button type="button" className="btn" onClick={onClose} aria-label="关闭快捷键设置">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
});
