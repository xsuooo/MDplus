import { useRef, useState } from 'react';
import { useDialogFocus } from '../lib/useDialogFocus';
import { deleteSnapshot, type RecoveryEntry } from '../lib/recovery';
import { confirmDialog, showMessage } from '../lib/dialog';
import { displayPath } from '../lib/paths';

export function RecoveryModal({
  entries,
  onRestore,
  onRemove,
  onClose,
}: {
  entries: RecoveryEntry[];
  onRestore: (id: string) => Promise<void>;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState<{
    id: string;
    kind: 'restore' | 'confirm-delete' | 'delete';
  } | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const actionRef = useRef<'restore' | 'delete' | null>(null);
  const busy = active !== null;
  const close = () => {
    if (actionRef.current !== 'delete') onClose();
  };
  const ref = useDialogFocus<HTMLDivElement>(close);
  const act = async (entry: RecoveryEntry, restore: boolean) => {
    if (actionRef.current || (restore && entry.damaged)) return;
    actionRef.current = restore ? 'restore' : 'delete';
    setActive({ id: entry.id, kind: restore ? 'restore' : 'confirm-delete' });
    setFailure(null);
    try {
      if (restore) await onRestore(entry.id);
      else {
        if (
          !(await confirmDialog(
            `永久删除「${entry.title}」的恢复副本和图片？删除后无法恢复，原文件不受影响。`,
          ))
        )
          return;
        setActive({ id: entry.id, kind: 'delete' });
        await deleteSnapshot(entry.id);
        onRemove(entry.id);
      }
    } catch {
      const message = restore
        ? '恢复失败。请勿清理应用数据，重新打开「恢复」检查后重试恢复。'
        : '删除未完成，副本可能已部分删除。原文件不受影响，请重新打开「恢复」检查。';
      setFailure({ id: entry.id, message });
      await showMessage(message, 'error');
    } finally {
      actionRef.current = null;
      setActive(null);
    }
  };
  return (
    <div className="modal-mask">
      <div
        ref={ref}
        className="modal recovery-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
        aria-describedby="recovery-description"
        aria-busy={busy}
        tabIndex={-1}
      >
        <h3 id="recovery-title">恢复未保存内容</h3>
        <p id="recovery-description" className="modal-description">
          恢复后会打开新副本，不覆盖原文件。副本在本机保留 7 天，包含文字和图片，未加密。
        </p>
        <div className="recovery-list">
          {entries.length === 0 && <p>没有需要恢复的内容。</p>}
          {entries.map((entry) => (
            <section className="recovery-entry" key={entry.id}>
              <strong>{entry.title}</strong>
              <p>
                {entry.originalPath ? displayPath(entry.originalPath) : '未保存的新文档'} ·{' '}
                {new Date(entry.updatedAt).toLocaleString()}
              </p>
              {entry.damaged && (
                <p id={`recovery-damage-${entry.id}`}>副本不完整，无法恢复；原文件不受影响。</p>
              )}
              {entry.cleanupError && <p role="status">过期副本未能自动清理，请稍后重试删除。</p>}
              {active?.id === entry.id && !failure && (
                <p role="status">
                  {active.kind === 'restore'
                    ? `正在恢复「${entry.title}」为新副本…可稍后处理，恢复会继续。`
                    : active.kind === 'confirm-delete'
                      ? `等待确认删除「${entry.title}」的恢复副本…`
                      : `正在删除「${entry.title}」的恢复副本…`}
                </p>
              )}
              {failure?.id === entry.id && <p role="alert">{failure.message}</p>}
              <div className="modal-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy || entry.damaged}
                  aria-describedby={entry.damaged ? `recovery-damage-${entry.id}` : undefined}
                  onClick={() => void act(entry, true)}
                >
                  {active?.id === entry.id && active.kind === 'restore' && !failure
                    ? '恢复中…'
                    : '恢复副本'}
                </button>
                <button className="btn" disabled={busy} onClick={() => void act(entry, false)}>
                  {active?.id === entry.id && active.kind !== 'restore' && !failure
                    ? active.kind === 'confirm-delete'
                      ? '等待删除确认…'
                      : '删除中…'
                    : '删除副本'}
                </button>
              </div>
            </section>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" disabled={busy && active?.kind !== 'restore'} onClick={close}>
            {entries.length ? '稍后处理' : '关闭'}
          </button>
        </div>
      </div>
    </div>
  );
}
