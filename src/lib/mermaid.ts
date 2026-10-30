import { $view } from '@milkdown/kit/utils';
import { isComposingEvent } from './shortcuts';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import type { EditorView, NodeViewConstructor } from '@milkdown/prose/view';
import type { Node as PMNode } from '@milkdown/prose/model';
import { errorMessage } from './errors';
import { NodeSelection } from '@milkdown/prose/state';
import type { MediaPreview } from './media';
import { renderDiagramMedia } from './diagramRender';
import { normalizeBodyFont } from './editorFont';

/** 当前存活视图的重渲染器集合,用于主题切换时让已渲染图表跟随重绘 */
const activeRenderers = new Set<() => Promise<void>>();

/** 主题变化时,让所有已渲染的 mermaid 图表按新主题重绘 */
export async function refreshMermaidTheme(): Promise<void> {
  await Promise.all([...activeRenderers].map((render) => render()));
}

/**
 * Mermaid 图表渲染插件。
 * Milkdown 的 $view 对返回 null 不回退默认视图,因此这里接管所有代码块:
 *  - language 为 mermaid 时渲染为图表，选中、查看与编辑分别操作;
 *  - 其它语言渲染为普通可编辑代码块。
 */
const mermaidView = (onPreview?: (media: MediaPreview) => void): NodeViewConstructor =>
  (node: PMNode, view: EditorView, getPos: () => number | undefined) => {
  const lang = String(node.attrs.language ?? '').toLowerCase();

  /* ---------- 非 mermaid:普通代码块 ---------- */
  if (lang !== 'mermaid') {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (lang) code.className = `language-${lang}`;
    pre.appendChild(code);
    return {
      dom: pre,
      contentDOM: code,
      update(next: PMNode): boolean {
        const nextLang = String(next.attrs.language ?? '').toLowerCase();
        if (nextLang === 'mermaid') return false; // 变成 mermaid,重建视图
        code.className = nextLang ? `language-${nextLang}` : '';
        return true;
      },
    };
  }

  /* ---------- mermaid 图表视图 ---------- */
  const dom = document.createElement('div');
  dom.className = 'md-mermaid-node';
  const holder = document.createElement('div');
  holder.className = 'md-mermaid-holder';
  const contentPre = document.createElement('pre');
  contentPre.className = 'md-mermaid-contentdom';
  const contentCode = document.createElement('code');
  contentPre.appendChild(contentCode);
  dom.appendChild(holder);
  dom.appendChild(contentPre);
  const controls = document.createElement('div');
  controls.className = 'md-media-controls';
  controls.contentEditable = 'false';
  const edit = document.createElement('button');
  edit.type = 'button'; edit.className = 'md-mermaid-edit';
  edit.textContent = '编辑图表';
  const enlarge = document.createElement('button');
  enlarge.type = 'button'; enlarge.className = 'md-mermaid-enlarge';
  enlarge.textContent = '放大查看'; enlarge.setAttribute('aria-label', '放大查看图表');
  enlarge.disabled = true;
  controls.append(edit, enlarge); dom.append(controls);

  let currentCode = node.textContent;
  let isDestroyed = false;
  let isEditing = false;
  let renderToken = 0;
  let finishPendingLoad: (() => void) | undefined;
  let media: MediaPreview | undefined;
  let layout: { identity: string; width: number; height: number } | undefined;
  let sourceInput: HTMLTextAreaElement | undefined;
  const select = () => {
    const pos = getPos();
    if (pos == null || view.isDestroyed) return;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
    view.focus();
  };
  holder.onclick = (event) => { if (!isEditing) { event.stopPropagation(); select(); } };
  controls.addEventListener('mousedown', (event) => event.preventDefault());
  edit.onclick = () => { select(); showEditor(holder, currentCode); };
  enlarge.onclick = () => { select(); if (media) onPreview?.(media); };

  /** 当前主题,mermaid 也跟随 */
  function diagramTheme(): 'dark' | 'light' {
    const theme = document.documentElement.dataset.theme;
    return theme === 'dark' ? 'dark' : 'light';
  }

  /** 异步渲染图表 */
  async function renderDiagram(code: string, fade = false): Promise<void> {
    const token = ++renderToken;
    finishPendingLoad?.();
    if (isDestroyed) return;
    dom.classList.add('loading');
    let preview: HTMLDivElement | undefined;

    try {
      // The constructor starts rendering before ProseMirror attaches this node.
      // Read inherited font settings only after it belongs to its actual tab.
      await Promise.resolve();
      if (isDestroyed || token !== renderToken) return;
      const font = normalizeBodyFont(dom.closest<HTMLElement>('[data-body-font]')?.dataset.bodyFont);
      const nextMedia = await renderDiagramMedia(code, diagramTheme(), font);
      if (isDestroyed || token !== renderToken) return;
      // Mermaid themes can differ by a few border pixels. Only content/font
      // changes may resize the document; a color change retains its layout box.
      const identity = `${font}\0${code}`;
      if (layout?.identity === identity) {
        nextMedia.width = layout.width; nextMedia.height = layout.height;
      } else layout = { identity, width: nextMedia.width, height: nextMedia.height };
      // Load the replacement invisibly without collapsing the current diagram.
      preview = document.createElement('div');
      preview.className = 'md-mermaid-preview md-mermaid-preview-pending';
      const image = document.createElement('img');
      image.src = nextMedia.src; image.draggable = false;
      image.alt = 'Mermaid 图表预览';
      image.style.width = `${nextMedia.width}px`;
      image.style.aspectRatio = `${nextMedia.width} / ${nextMedia.height}`;
      preview.append(image);
      const ready = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          image.removeEventListener('load', finish);
          image.removeEventListener('error', fail);
          if (finishPendingLoad === finish) finishPendingLoad = undefined;
        };
        const finish = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error('图表图像无法解码')); };
        finishPendingLoad = finish;
        image.addEventListener('load', finish, { once: true });
        image.addEventListener('error', fail, { once: true });
      });
      holder.appendChild(preview);
      await ready;
      if (isDestroyed || token !== renderToken) {
        preview.remove();
        return;
      }
      if (fade && holder.querySelector('.md-mermaid-preview:not(.md-mermaid-preview-pending)')
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        preview.classList.add('md-mermaid-preview-revealing');
        await preview.animate([{ opacity: 0 }, { opacity: 1 }],
          { duration: 160, easing: 'ease-out', fill: 'forwards' }).finished.catch(() => {});
        if (isDestroyed || token !== renderToken) { preview.remove(); return; }
        preview.classList.remove('md-mermaid-preview-revealing');
      }
      preview.classList.remove('md-mermaid-preview-pending');
      holder.className = 'md-mermaid-holder';
      holder.replaceChildren(preview);
      media = nextMedia;
      enlarge.disabled = !onPreview;
      dom.classList.remove('loading');
    } catch (err) {
      preview?.remove();
      if (isDestroyed || token !== renderToken) return;
      media = undefined; enlarge.disabled = true;
      holder.textContent = `图表无法预览。请点击“编辑图表”修正源码。\n${errorMessage(err)}`;
      holder.className = 'md-mermaid-holder md-mermaid-error';
      dom.classList.remove('loading');
    }
  }

  /** 显示源码编辑区 */
  function showEditor(holder: HTMLElement, code: string): void {
    isEditing = true;
    controls.hidden = true;
    renderToken += 1;
    finishPendingLoad?.();
    dom.classList.remove('loading');
    holder.className = 'md-mermaid-holder md-mermaid-editing';
    const ta = document.createElement('textarea');
    sourceInput = ta;
    ta.className = 'md-mermaid-textarea';
    ta.setAttribute('aria-label', 'Mermaid 图表源码');
    ta.value = code;
    const bar = document.createElement('div');
    bar.className = 'md-mermaid-bar';
    const hint = document.createElement('span');
    hint.className = 'md-mermaid-hint';
    hint.textContent = '编辑 Mermaid 源码,失焦或点击预览生效';
    const btn = document.createElement('button');
    btn.className = 'md-mermaid-commit';
    btn.textContent = '预览';
    bar.appendChild(hint);
    bar.appendChild(btn);

    holder.innerHTML = '';
    holder.appendChild(bar);
    holder.appendChild(ta);

    const write = (): void => {
      if (isDestroyed || !isEditing) return;
      const value = ta.value;
      const changed = value !== currentCode;
      currentCode = value;
      const pos = getPos();
      // 内容有变化才 dispatch(避免 blur 产生无意义的撤销历史);
      // pos 为 null 说明节点已销毁/替换,直接跳过写回
      if (pos != null) {
        const nodeAt = view.state.doc.nodeAt(pos);
        if (nodeAt?.type.name === 'code_block' && String(nodeAt.attrs.language).toLowerCase() === 'mermaid' && changed) {
          const tr = view.state.tr.insertText(value, pos + 1, pos + nodeAt.nodeSize - 1);
          view.dispatch(tr);
        }
      }
    };
    const commit = (): void => {
      if (isDestroyed || !isEditing) return;
      write();
      isEditing = false;
      sourceInput = undefined;
      controls.hidden = false;
      // 无论内容是否变化,都退出编辑态并重新渲染
      void renderDiagram(currentCode);
    };
    // Save/recovery must see the draft even when Ctrl+S never blurs this textarea.
    ta.addEventListener('input', write);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', commit);
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !isComposingEvent(e)) {
        e.preventDefault();
        ta.blur();
      }
    });
    ta.focus();
  }

  void renderDiagram(currentCode);

  // 注册到主题刷新集合,销毁时移除
  const renderer = () => isEditing ? Promise.resolve() : renderDiagram(currentCode, true);
  activeRenderers.add(renderer);

  return {
    dom,
    // 隐藏的 contentDOM,让 ProseMirror 与文档文本保持同步
    contentDOM: contentCode,
    update(node: PMNode): boolean {
      if (String(node.attrs.language ?? '').toLowerCase() !== 'mermaid') return false;
      if (node.textContent !== currentCode) {
        currentCode = node.textContent;
        if (isEditing && sourceInput) sourceInput.value = currentCode;
        else void renderDiagram(currentCode);
      }
      return true;
    },
    ignoreMutation: () => true,
    stopEvent: (event) => event.target instanceof Element
      && !!event.target.closest('.md-media-controls, .md-mermaid-textarea, .md-mermaid-bar'),
    destroy: () => {
      isDestroyed = true;
      finishPendingLoad?.();
      activeRenderers.delete(renderer);
    },
  };
};

export const mermaidPlugin = (onPreview?: (media: MediaPreview) => void) => $view(codeBlockSchema.node, () => mermaidView(onPreview));
