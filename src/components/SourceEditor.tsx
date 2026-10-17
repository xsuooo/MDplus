import { memo, useLayoutEffect, useRef, type ClipboardEvent } from 'react';
import { pasteSourceImage } from '../lib/sourcePaste';
import { IconCode } from './icons';

interface SourceEditorProps {
  tabId: string;
  value: string;
  onChange: (text: string) => void;
  onClose: () => void;
  onImagePaste?: (tabId: string, file: File) => Promise<string>;
}

/** 源码模式:一个全屏覆盖的 Markdown 源文本编辑区 */
export const SourceEditor = memo(function SourceEditor({ tabId, value, onChange, onClose, onImagePaste }: SourceEditorProps) {
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [tabId, value]);

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onImagePaste) return;
    const current = generation.current;
    void pasteSourceImage(event, event.currentTarget, (file) => onImagePaste(tabId, file), onChange,
      () => generation.current === current);
  };

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
        onChange={(e) => {
          generation.current += 1;
          onChange(e.target.value);
        }}
        onSelect={() => { generation.current += 1; }}
        onPaste={handlePaste}
        spellCheck={false}
        aria-label="Markdown 源码"
        autoFocus
      />
    </div>
  );
});
