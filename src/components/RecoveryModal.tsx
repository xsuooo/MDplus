import { useState } from 'react';
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
  const ref = useDialogFocus<HTMLDivElement>(onClose);
  const [busy, setBusy] = useState(false);
  const act = async (entry: RecoveryEntry, restore: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (restore) await onRestore(entry.id);
      else {
        if (
          !(await confirmDialog(
            `永久删除「${entry.title}」的恢复副本和图片？删除后无法恢复，原文件不受影响。`,
          ))
        )
          return;
        await deleteSnapshot(entry.id);
        onRemove(entry.id);
      }
    } catch {
      await showMessage('恢复操作失败，副本仍保留。请勿清理应用数据，稍后重试。', 'error');
    } finally {
      setBusy(false);
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
        tabIndex={-1}
      >
        <h3 id="recovery-title">恢复未保存内容</h3>
        <p className="modal-description">
          恢复后会打开新副本，不覆盖原文件。副本在本机保留 7 天，包含文字和图片，未加密。
        </p>
        <div className="recovery-list">
          {entries.length === 0 && <p>没有需要恢复的内容。</p>}
          {entries.map((entry) => (
            <section className="recovery-entry" key={entry.id}>
              <strong>{entry.damaged ? '副本不完整，无法恢复' : entry.title}</strong>
              <p>
                {entry.originalPath ? displayPath(entry.originalPath) : '未保存的新文档'} ·{' '}
                {new Date(entry.updatedAt).toLocaleString()}
              </p>
              {entry.cleanupError && <p role="status">过期副本未能自动清理，请稍后重试删除。</p>}
              <div className="modal-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy || entry.damaged}
                  onClick={() => void act(entry, true)}
                >
                  恢复副本
                </button>
                <button className="btn" disabled={busy} onClick={() => void act(entry, false)}>
                  删除副本
                </button>
              </div>
            </section>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={onClose}>
            {entries.length ? '稍后处理' : '关闭'}
          </button>
        </div>
      </div>
    </div>
  );
}
