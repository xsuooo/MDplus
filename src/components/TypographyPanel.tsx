import { useEffect, useRef, useState } from 'react';
import {
  BODY_FONTS,
  CODE_FONTS,
  normalizeBodyFont,
  type BodyFont,
  type CodeFont,
} from '../lib/editorFont';
import { isComposingEvent } from '../lib/shortcuts';
import { Presence } from '../lib/presence';
import { IconClose } from './icons';

export function TypographyPanel({
  bodyFont,
  codeFont,
  onBodyFont,
  onCodeFont,
}: {
  bodyFont: BodyFont;
  codeFont: CodeFont;
  onBodyFont: (font: BodyFont) => void;
  onCodeFont: (font: CodeFont) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const selectedCode = CODE_FONTS.find((font) => font.id === codeFont)!;
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
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
    <div
      className="typography-control"
      ref={wrapper}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        className="statusbar-theme"
        aria-label="排版设置"
        aria-expanded={open}
        aria-controls={open ? 'typography-panel' : undefined}
        aria-haspopup="dialog"
        title="全局设置界面、正文与代码字体"
        onClick={() => setOpen((value) => !value)}
      >
        排版
      </button>
      <Presence present={open}>
        <div
          id="typography-panel"
          ref={panel}
          className="typography-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="typography-title"
          onKeyDown={(event) => {
            if (
              event.key === 'Escape' &&
              !event.defaultPrevented &&
              !isComposingEvent(event.nativeEvent)
            ) {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="typography-head">
            <div>
              <h3 id="typography-title">排版设置</h3>
              <p>找到适合你的阅读节奏</p>
            </div>
            <button
              className="toolbar-btn toolbar-btn-icon"
              aria-label="关闭排版设置"
              onClick={close}
            >
              <IconClose size={16} />
            </button>
          </div>
          <div className="typography-content">
            <section className="typography-group" aria-labelledby="body-font-label">
              <label id="body-font-label" className="typography-label" htmlFor="body-font">
                界面与正文字体
              </label>
              <p className="typography-description" id="body-font-scope">
                用于菜单、标题与正文；不影响代码。
              </p>
              <select
                id="body-font"
                aria-label="界面与正文字体"
                aria-describedby="body-font-scope"
                value={bodyFont}
                onChange={(event) => onBodyFont(normalizeBodyFont(event.target.value))}
              >
                {BODY_FONTS.map((font) => (
                  <option key={font.id} value={font.id}>
                    {font.label}
                  </option>
                ))}
              </select>
              <div className="typography-preview-body" role="group" aria-label="正文排版预览">
                <p>把注意力留给内容，让文字自然呼吸。</p>
                <p>
                  <strong>清晰重点 Bold</strong> · <em>轻柔强调 Italic</em>
                </p>
              </div>
            </section>
            <fieldset className="typography-group" aria-describedby="code-font-scope">
              <legend className="typography-label">源码与代码字体</legend>
              <p className="typography-description" id="code-font-scope">
                用于源码、代码块、行内代码及快捷键按键。相同样张，直接比较；不改变正文。
              </p>
              <div className="font-options">
                {CODE_FONTS.map((font) => (
                  <label
                    key={font.id}
                    className={`font-option${font.id === codeFont ? ' selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="code-font"
                      value={font.id}
                      checked={font.id === codeFont}
                      aria-label={font.label}
                      aria-describedby={`${font.id}-description`}
                      onChange={() => onCodeFont(font.id)}
                    />
                    <span className="font-option-content">
                      <span className="font-option-heading">
                        <strong>{font.purpose}</strong>
                        <span className="font-option-state" aria-hidden="true">
                          {font.id === codeFont ? '使用中' : ''}
                        </span>
                      </span>
                      <span className="font-option-name">{font.label}</span>
                      <code
                        className="font-option-sample"
                        style={{ fontFamily: `${font.family}, var(--font-mono)` }}
                        aria-hidden="true"
                      >
                        {'0O 1Il  != !== =>\n// 中文注释，阅读节奏'}
                      </code>
                      <span className="font-option-description" id={`${font.id}-description`}>
                        {font.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <details className="typography-note">
              <summary>字体与离线使用说明</summary>
              <p>
                字体内置，离线可用；不会安装到系统。系统文件对话框和打印窗口仍使用 Windows
                字体。文楷使用真实 Medium 字重强调；斜体可由浏览器合成。
              </p>
            </details>
          </div>
          <div className="typography-footer">
            <p role="status">
              当前代码方案：<strong>{selectedCode.purpose}</strong>
            </p>
            <span>全局即时生效，独立记住选择；不修改 Markdown。</span>
          </div>
        </div>
      </Presence>
    </div>
  );
}
