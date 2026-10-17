import { memo, useEffect, useRef, useState } from 'react';
import { useDialogFocus } from '../lib/useDialogFocus';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  applyShortcut,
  conflictReport,
  formatShortcut,
  shortcutFromEvent,
  type ShortcutAction,
  type ShortcutBindings,
  type ShortcutDefinition,
} from '../lib/shortcuts';

const GROUP_ORDER: ReadonlyArray<ShortcutDefinition['group']> = ['文件', '视图', '标签'];

const ACTION_LABELS = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition.label]),
) as Record<ShortcutAction, string>;

interface ShortcutModalProps {
  bindings: ShortcutBindings;
  onChange: (bindings: ShortcutBindings) => void;
  onClose: () => void;
}

export const ShortcutModal = memo(function ShortcutModal({ bindings, onChange, onClose }: ShortcutModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [conflict, setConflict] = useState<{ action: ShortcutAction; actions: ShortcutAction[] } | null>(null);
  // 捕获期间需要读最新绑定,避免 effect 持有过期闭包
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 捕获阶段截获:既不让 Esc 走到 useDialogFocus 的关闭逻辑,也不让组合键触发应用动作
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(null);
        setConflict(null);
        return;
      }
      const accelerator = shortcutFromEvent(event);
      if (!accelerator) return; // 只有修饰键等非法组合:保持捕获态

      const result = applyShortcut(bindingsRef.current, capturing, accelerator);
      if (result.conflict.length > 0) {
        setConflict({ action: capturing, actions: result.conflict });
        return; // 不应用,保持原绑定
      }
      setConflict(null);
      setCapturing(null);
      onChange(result.bindings);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, onChange]);

  const startCapture = (action: ShortcutAction) => {
    setConflict(null);
    setCapturing((current) => (current === action ? null : action));
  };

  const clearBinding = (action: ShortcutAction) => {
    setCapturing(null);
    setConflict(null);
    onChange({ ...bindings, [action]: null });
  };

  const restoreDefaults = () => {
    setCapturing(null);
    setConflict(null);
    onChange({ ...DEFAULT_SHORTCUTS });
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
        aria-describedby="shortcuts-description"
        tabIndex={-1}
      >
        <h3 id="shortcuts-title">快捷键</h3>
        <p id="shortcuts-description" className="modal-description">
          点击「修改」后按下新的组合键;按 Esc 取消。冲突的组合键不会被保存。
        </p>
        {duplicateGroups.length > 0 && (
          <div className="shortcut-duplicate-warning" role="alert">
            <strong>存在重复绑定,部分快捷键不会生效</strong>
            <ul>
              {duplicateGroups.map((group) => (
                <li key={group.accelerator}>
                  {formatShortcut(group.accelerator)} 已由「{ACTION_LABELS[group.active]}」使用,
                  「{group.ignored.map((action) => ACTION_LABELS[action]).join('、')}」不会触发
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
                  const isCapturing = capturing === definition.id;
                  const message = conflictText(definition.id);
                  const binding = bindings[definition.id];
                  return (
                    <tr key={definition.id} className="shortcut-row">
                      <th scope="row">{label}</th>
                      <td>
                        {isCapturing ? (
                          <kbd className="shortcut-kbd shortcut-kbd-capturing">按下新组合键…</kbd>
                        ) : (
                          <kbd className={`shortcut-kbd${binding ? '' : ' shortcut-kbd-unbound'}`}>
                            {formatShortcut(binding)}
                          </kbd>
                        )}
                        {ignoredActions.has(definition.id) && (
                          <span className="shortcut-ignored">不生效</span>
                        )}
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
                          onClick={() => startCapture(definition.id)}
                          aria-label={`${isCapturing ? '取消修改' : '修改'}「${label}」快捷键`}
                          aria-pressed={isCapturing}
                        >
                          {isCapturing ? '取消' : '修改'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => clearBinding(definition.id)}
                          aria-label={`清除「${label}」快捷键`}
                          disabled={!binding}
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
