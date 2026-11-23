import { memo } from 'react';
import { useDialogFocus } from '../lib/useDialogFocus';

interface CloseConfirmModalProps {
  title: string;
  busy: boolean;
  onConfirm: (action: 'save' | 'discard' | 'cancel') => void;
}

export const CloseConfirmModal = memo(function CloseConfirmModal({
  title,
  busy,
  onConfirm,
}: CloseConfirmModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(() => onConfirm('cancel'));

  return (
    <div className="modal-mask" role="presentation">
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-document-title"
        aria-describedby="close-document-description"
        aria-busy={busy}
        tabIndex={-1}
      >
        <h3 id="close-document-title">关闭「{title}」</h3>
        <p id="close-document-description">
          {busy ? (
            <span role="status">正在处理关闭，可选择「继续编辑」取消本次关闭。</span>
          ) : (
            '更改尚未保存。丢弃更改并关闭后，这些改动不会自动恢复。'
          )}
        </p>
        <div className="modal-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => onConfirm('save')}>
            保存并关闭
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={() => onConfirm('discard')}>
            丢弃更改并关闭
          </button>
          <button className="btn" onClick={() => onConfirm('cancel')}>
            继续编辑
          </button>
        </div>
      </div>
    </div>
  );
});
