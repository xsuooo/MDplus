import { useEffect, useRef, useState } from 'react';
import {
  BODY_FONTS,
  CODE_FONTS,
  normalizeBodyFont,
  type BodyFont,
  type CodeFont,
} from '../lib/editorFont';
import { isComposingEvent } from '../lib/shortcuts';
import { normalizeEditorWidth, type EditorWidth } from '../lib/editorWidth';
import { Presence } from '../lib/presence';
import { IconClose } from './icons';

export function TypographyPanel({
  bodyFont,
  codeFont,
  onBodyFont,
  onCodeFont,
  editorWidth,
  onEditorWidth,
}: {
  bodyFont: BodyFont;
  codeFont: CodeFont;
  onBodyFont: (font: BodyFont) => void;
  onCodeFont: (font: CodeFont) => void;
  editorWidth: EditorWidth;
  onEditorWidth: (width: EditorWidth) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
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
        className="statusbar-theme statusbar-typography"
        aria-label="排版设置"
        aria-expanded={open}
        aria-controls={open ? 'typography-panel' : undefined}
        aria-haspopup="dialog"
        title="设置正文宽度与字体"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="statusbar-typography-mark" aria-hidden="true">
          Aa
        </span>
        <span className="statusbar-label">排版</span>
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
            <fieldset className="typography-group">
              <legend className="typography-label">正文宽度</legend>
              <select
                aria-label="正文宽度"
                value={editorWidth}
                onChange={(event) => onEditorWidth(normalizeEditorWidth(event.target.value))}
              >
                <option value="centered">居中阅读</option>
                <option value="full">铺满窗口</option>
              </select>
            </fieldset>
            <section className="typography-group" aria-labelledby="body-font-label">
              <label id="body-font-label" className="typography-label" htmlFor="body-font">
                界面与正文字体
              </label>
              <select
                id="body-font"
                aria-label="界面与正文字体"
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
                <p>用文字记录想法。</p>
                <p>
                  <strong>重点</strong> 与 <em>强调</em>
                </p>
              </div>
            </section>
            <fieldset className="typography-group">
              <legend className="typography-label">Markdown 和代码字体</legend>
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
                      onChange={() => onCodeFont(font.id)}
                    />
                    <span className="font-option-content">
                      <span className="font-option-name">{font.label}</span>
                      <code
                        className="font-option-sample"
                        style={{ fontFamily: `${font.family}, var(--font-mono)` }}
                        aria-hidden="true"
                      >
                        {'0O 1Il  != =>  // 中文注释'}
                      </code>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <div className="typography-footer">设置自动保存，仅影响显示。</div>
        </div>
      </Presence>
    </div>
  );
}
