import { useEffect, useRef, useState } from 'react';
import { BODY_FONTS, CODE_FONTS, normalizeBodyFont, normalizeCodeFont, type BodyFont, type CodeFont } from '../lib/editorFont';
import { isComposingEvent } from '../lib/shortcuts';
import { IconClose } from './icons';

export function TypographyPanel({ bodyFont, codeFont, onBodyFont, onCodeFont }: {
  bodyFont: BodyFont; codeFont: CodeFont;
  onBodyFont: (font: BodyFont) => void; onCodeFont: (font: CodeFont) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('select')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return (
    <div className="typography-control" ref={wrapper} onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={trigger} className="statusbar-theme" aria-label="排版设置" aria-expanded={open}
        aria-controls={open ? 'typography-panel' : undefined} aria-haspopup="dialog"
        title="全局设置界面、正文与代码字体" onClick={() => setOpen((value) => !value)}>
        排版
      </button>
      {open && (
        <div id="typography-panel" ref={panel} className="typography-panel" role="dialog"
          aria-modal="false" aria-labelledby="typography-title" onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented && !isComposingEvent(event.nativeEvent)) {
              event.preventDefault(); event.stopPropagation(); close();
            }
          }}>
          <header className="typography-head">
            <h3 id="typography-title">排版设置</h3>
            <button className="toolbar-btn toolbar-btn-icon" aria-label="关闭排版设置" onClick={close}><IconClose size={16} /></button>
          </header>
          <p className="typography-description">界面与正文统一，代码和快捷键按键保持等宽。全局即时生效，两项选择独立保存。</p>
          <label className="typography-label" htmlFor="body-font">界面与正文字体</label>
          <select id="body-font" aria-label="界面与正文字体" value={bodyFont} onChange={(event) => onBodyFont(normalizeBodyFont(event.target.value))}>
            {BODY_FONTS.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
          </select>
          <div className="typography-preview-body" aria-label="正文排版预览">
            <p>把注意力留给内容，让每一段文字自然呼吸。</p>
            <p>Read naturally. 中文 English 0123456789</p>
            <p><strong>清晰的重点 Bold</strong> · <em>轻柔的强调 Italic</em></p>
          </div>
          <label className="typography-label" htmlFor="code-font">源码与代码字体</label>
          <select id="code-font" aria-label="源码与代码字体" value={codeFont} onChange={(event) => onCodeFont(normalizeCodeFont(event.target.value))}>
            {CODE_FONTS.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
          </select>
          <pre className="typography-preview-code" aria-label="代码排版预览">{'const title = "中文标题";\nif (count !== 0) return title;\n// 0123456789  =>  [] {} ()'}</pre>
          <p className="typography-note">字体内置，离线可用；不会安装到系统，也不会修改 Markdown。系统文件对话框和打印窗口仍使用 Windows 字体。文楷使用真实 Medium 字重强调；斜体可由浏览器合成。</p>
        </div>
      )}
    </div>
  );
}
