import { memo } from 'react';
import { IconCode, IconNew } from './icons';
import { useDialogFocus } from '../lib/useDialogFocus';

interface NewFileModalProps {
  onCancel: () => void;
  onConfirm: (kind: 'blank' | 'basic') => void;
}

export const NewFileModal = memo(function NewFileModal({ onCancel, onConfirm }: NewFileModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onCancel);

  return (
    <div className="modal-mask" onClick={onCancel} role="presentation">
      <div
        ref={dialogRef}
        className="modal newfile-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-document-title"
        aria-describedby="new-document-description"
        tabIndex={-1}
      >
        <h3 id="new-document-title">新建文档</h3>
        <p id="new-document-description" className="modal-description">选择一个起点,之后仍可随时修改内容。</p>
        <div className="newfile-options">
          <button type="button" className="newfile-card" onClick={() => onConfirm('blank')}>
            <span className="newfile-icon"><IconNew size={20} /></span>
            <span className="newfile-name">空白文档</span>
            <span className="newfile-desc">从一个空白的页面开始</span>
          </button>
          <button type="button" className="newfile-card" onClick={() => onConfirm('basic')}>
            <span className="newfile-icon"><IconCode size={20} /></span>
            <span className="newfile-name">基础模板</span>
            <span className="newfile-desc">包含标题、代码、公式、图表示例</span>
          </button>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
});
