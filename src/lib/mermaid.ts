import { $view } from '@milkdown/kit/utils';
import { isComposingEvent } from './shortcuts';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import type { EditorView, NodeViewConstructor } from '@milkdown/prose/view';
import type { Node as PMNode } from '@milkdown/prose/model';
import { errorMessage } from './errors';

/** 当前存活视图的重渲染器集合,用于主题切换时让已渲染图表跟随重绘 */
const activeRenderers = new Set<() => void>();

/** 主题变化时,让所有已渲染的 mermaid 图表按新主题重绘 */
export function refreshMermaidTheme(): void {
  activeRenderers.forEach((fn) => fn());
}

/**
 * Mermaid 图表渲染插件。
 * Milkdown 的 $view 对返回 null 不回退默认视图,因此这里接管所有代码块:
 *  - language 为 mermaid 时渲染为实时图表(点击可编辑源码);
 *  - 其它语言渲染为普通可编辑代码块。
 */
const mermaidView: NodeViewConstructor = (node: PMNode, view: EditorView, getPos: () => number | undefined) => {
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

  let currentCode = node.textContent;
  let isDestroyed = false;
  let isEditing = false;
  let renderToken = 0;

  /** 当前主题,mermaid 也跟随 */
  function diagramTheme(): 'dark' | 'default' {
    const theme = document.documentElement.dataset.theme;
    return theme === 'dark' ? 'dark' : 'default';
  }

  /** 异步渲染图表 */
  async function renderDiagram(code: string): Promise<void> {
    const token = ++renderToken;
    if (isDestroyed) return;
    dom.classList.add('loading');
    let preview: HTMLDivElement | undefined;

    try {
      const { default: mermaid } = await import('mermaid');
      if (isDestroyed || token !== renderToken) return;
      // sandbox 模式:渲染结果包进无 allow-scripts/allow-same-origin 的 iframe,
      // 图中 click 指令等 javascript: 链接无法执行,也无法访问 Tauri IPC
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'sandbox',
        theme: diagramTheme(),
        fontFamily: getComputedStyle(dom).getPropertyValue('--font-sans').trim() || 'sans-serif',
      });
      const id = `md-mmd-${Math.random().toString(36).slice(2, 9)}`;
      const { svg } = await mermaid.render(id, code);
      if (isDestroyed || token !== renderToken) return;
      // Load the replacement invisibly without collapsing the current diagram.
      preview = document.createElement('div');
      preview.className = 'md-mermaid-preview md-mermaid-preview-pending';
      preview.innerHTML = svg;
      const frame = preview.querySelector('iframe');
      const ready = frame ? new Promise<void>((resolve) => {
        frame.addEventListener('load', () => resolve(), { once: true });
      }) : Promise.resolve();
      holder.appendChild(preview);
      await ready;
      if (isDestroyed || token !== renderToken) {
        preview.remove();
        return;
      }
      preview.classList.remove('md-mermaid-preview-pending');
      holder.className = 'md-mermaid-holder';
      holder.replaceChildren(preview);
      holder.onclick = () => showEditor(holder, currentCode);
      dom.classList.remove('loading');
    } catch (err) {
      preview?.remove();
      if (isDestroyed || token !== renderToken) return;
      holder.textContent = `⚠ Mermaid 渲染失败:${errorMessage(err)}`;
      holder.className = 'md-mermaid-holder md-mermaid-error';
      holder.onclick = () => showEditor(holder, currentCode);
      dom.classList.remove('loading');
    }
  }

  /** 显示源码编辑区 */
  function showEditor(holder: HTMLElement, code: string): void {
    isEditing = true;
    renderToken += 1;
    dom.classList.remove('loading');
    holder.onclick = null;
    const ta = document.createElement('textarea');
    ta.className = 'md-mermaid-textarea';
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

    const commit = (): void => {
      if (isDestroyed || !isEditing) return;
      isEditing = false;
      const value = ta.value;
      const changed = value !== currentCode;
      currentCode = value;
      const pos = getPos();
      // 内容有变化才 dispatch(避免 blur 产生无意义的撤销历史);
      // pos 为 null 说明节点已销毁/替换,直接跳过写回
      if (pos != null) {
        const nodeAt = view.state.doc.nodeAt(pos);
        if (nodeAt && nodeAt.type.name === 'code_block' && changed) {
          const tr = view.state.tr.insertText(value, pos + 1, pos + nodeAt.nodeSize - 1);
          view.dispatch(tr);
        }
      }
      // 无论内容是否变化,都退出编辑态并重新渲染
      void renderDiagram(value);
    };
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
  const renderer = () => { if (!isEditing) void renderDiagram(currentCode); };
  activeRenderers.add(renderer);

  return {
    dom,
    // 隐藏的 contentDOM,让 ProseMirror 与文档文本保持同步
    contentDOM: contentCode,
    update(node: PMNode): boolean {
      if (String(node.attrs.language ?? '').toLowerCase() !== 'mermaid') return false;
      if (node.textContent !== currentCode) {
        currentCode = node.textContent;
        void renderDiagram(currentCode);
      }
      return true;
    },
    ignoreMutation: () => true,
    stopEvent: () => true,
    destroy: () => {
      isDestroyed = true;
      activeRenderers.delete(renderer);
    },
  };
};

export const mermaidPlugin = $view(codeBlockSchema.node, () => mermaidView);
