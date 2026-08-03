import { memo } from 'react';
import { IconCode } from './icons';

interface SourceEditorProps {
  value: string;
  onChange: (text: string) => void;
  onClose: () => void;
}

/** 源码模式:一个全屏覆盖的 Markdown 源文本编辑区 */
export const SourceEditor = memo(function SourceEditor({ value, onChange, onClose }: SourceEditorProps) {
  return (
    <div className="source-editor" aria-label="Markdown 源码编辑">
      <div className="source-editor-head">
        <div className="source-editor-title"><IconCode size={15} /> <span>源码模式</span></div>
        <button className="source-editor-close" onClick={onClose} title="返回编辑模式" aria-label="返回编辑模式">
          完成
        </button>
      </div>
      <textarea
        className="source-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label="Markdown 源码"
        autoFocus
      />
    </div>
  );
});
