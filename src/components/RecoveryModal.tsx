import { useState } from 'react';
import { useDialogFocus } from '../lib/useDialogFocus';
import { clearRecovery, type RecoveryEntry } from '../lib/recovery';
import { confirmDialog, showMessage } from '../lib/dialog';

export function RecoveryModal({ entries, onRestore, onRemove, onClose }: {
  entries: RecoveryEntry[]; onRestore: (id: string) => Promise<void>;
  onRemove: (id: string) => void; onClose: () => void;
}) {
  const ref = useDialogFocus<HTMLDivElement>(onClose);
  const [busy, setBusy] = useState(false);
  const act = async (entry: RecoveryEntry, restore: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (restore) await onRestore(entry.id);
      else {
        if (!await confirmDialog(`永久删除「${entry.title}」的恢复副本和缓存图片？原文档不受影响。`)) return;
        await clearRecovery(entry.id);
        onRemove(entry.id);
      }
    } catch {
      await showMessage('恢复操作失败，副本仍保留。请勿清理应用数据，稍后重试。', 'error');
    } finally { setBusy(false); }
  };
  return (
    <div className="modal-mask">
      <div ref={ref} className="modal recovery-modal" role="dialog" aria-modal="true"
        aria-labelledby="recovery-title" tabIndex={-1}>
        <h3 id="recovery-title">恢复未保存内容</h3>
        <p className="modal-description">恢复为未保存副本，不覆盖原文档。本机副本包含原文和图片，未加密；未处理的副本保留 7 天。</p>
        <div className="recovery-list">
          {entries.length === 0 && <p>没有待恢复的草稿。</p>}
          {entries.map((entry) => (
            <section className="recovery-entry" key={entry.id}>
              <strong>{entry.damaged ? '未完成或损坏的恢复缓存' : entry.title}</strong>
              <p>{entry.originalPath ?? '未保存的新文档'} · {new Date(entry.updatedAt).toLocaleString()}</p>
              <div className="modal-actions">
                <button className="btn btn-primary" disabled={busy || entry.damaged} onClick={() => void act(entry, true)}>恢复副本</button>
                <button className="btn" disabled={busy} onClick={() => void act(entry, false)}>删除副本</button>
              </div>
            </section>
          ))}
        </div>
        <div className="modal-actions"><button className="btn" disabled={busy} onClick={onClose}>稍后处理</button></div>
      </div>
    </div>
  );
}
