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
        tabIndex={-1}
      >
        <h3 id="close-document-title">关闭「{title}」</h3>
        <p id="close-document-description">该文档有未保存的改动,是否保存?</p>
        <div className="modal-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => onConfirm('save')}>
            保存
          </button>
          <button className="btn" disabled={busy} onClick={() => onConfirm('discard')}>
            放弃
          </button>
          <button className="btn" onClick={() => onConfirm('cancel')}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
});
