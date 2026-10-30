import {
  Editor,
  EditorStatus,
  rootCtx,
  defaultValueCtx,
  parserCtx,
  serializerCtx,
  editorViewCtx,
} from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import {
  undo as pmUndo,
  redo as pmRedo,
  undoDepth,
  redoDepth,
} from '@milkdown/prose/history';
import { Plugin, TextSelection } from '@milkdown/prose/state';
import { commonmark, imageSchema } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';

import { $prose, $view, getMarkdown as utilsGetMarkdown } from '@milkdown/kit/utils';
import { math } from '@milkdown/plugin-math';
import { prism } from '@milkdown/plugin-prism';
import { nord } from '@milkdown/theme-nord';
import { mermaidPlugin } from './mermaid';
import { searchPlugin } from './search';
import { computeStats } from './stats';
import { taskListPlugin } from './tasklist';
import { firstClipboardImage } from './sourcePaste';
import { configureMarkdownSchemas } from './markdownSchemas';
import type { EditorUpdate, OutlineItem } from './types';

/** 编辑器更新回调 */
export interface EditorCallbacks {
  onUpdate: (update: EditorUpdate) => void;
  onImagePaste?: (file: File) => Promise<string>;
  resolveImageSource?: (url: string) => string;
  captureImagePaste?: () => () => boolean;
}

/** 从 ProseMirror doc 提取标题大纲 */
function extractOutline(doc: import('@milkdown/prose/model').Node): OutlineItem[] {
  const items: OutlineItem[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      items.push({ level: node.attrs.level as number, text: node.textContent, pos });
    }
    return true;
  });
  return items;
}

/** 读取撤销/重做深度(history 插件未启用时安全返回 false) */
function historyState(doc: import('@milkdown/prose/state').EditorState): { canUndo: boolean; canRedo: boolean } {
  try {
    return { canUndo: undoDepth(doc) > 0, canRedo: redoDepth(doc) > 0 };
  } catch {
    return { canUndo: false, canRedo: false };
  }
}

/** 构建 Milkdown 编辑器 */
export function createEditor(root: HTMLElement, content: string, callbacks: EditorCallbacks): Editor {
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, content);
    })
    .config(configureMarkdownSchemas)
    .use(commonmark)
    .use(gfm)
    .use(history)
    // Milkdown 的 listener 会防抖 200ms，不能作为保存/关闭的内容源。
    // view.update 在事务提交后同步执行；仅 UI 渲染仍由 App 节流。
    .use($prose((ctx) => new Plugin({
      view: () => ({
        update: (view, previous) => {
          if (view.state.doc.eq(previous.doc)) return;
          const markdown = ctx.get(serializerCtx)(view.state.doc);
          callbacks.onUpdate({
            markdown,
            outline: extractOutline(view.state.doc),
            stats: computeStats(markdown),
            ...historyState(view.state),
          });
        },
      }),
    })))
    .use(math)
    .use(prism)
    .use(nord as unknown as import('@milkdown/kit/ctx').MilkdownPlugin)
    .use(mermaidPlugin)
    .use($prose(() => searchPlugin))
    .use($prose(() => taskListPlugin));

  if (callbacks.resolveImageSource) {
    editor.use($view(imageSchema.node, () => (node) => {
      const dom = document.createElement('img');
      const render = (image: typeof node) => {
        // Keep document URLs relative; only the rendered image uses cached bytes.
        dom.src = callbacks.resolveImageSource!(image.attrs.src);
        dom.alt = image.attrs.alt ?? '';
        dom.title = image.attrs.title ?? '';
      };
      render(node);
      return {
        dom,
        update: (next) => {
          if (next.type !== node.type) return false;
          render(next);
          return true;
        },
      };
    }));
  }

  // 添加图片粘贴支持
  if (callbacks.onImagePaste) {
    let removePasteListener: (() => void) | null = null;
    editor.onStatusChange((status) => {
      if (status === EditorStatus.Destroyed) {
        removePasteListener?.();
        removePasteListener = null;
      }
    });
    editor.config((ctx) => {
      ctx.get(editorViewCtx);
      // 在编辑器挂载后添加粘贴监听
      setTimeout(() => {
        if (editor.status === EditorStatus.Destroyed) return;
        const view = ctx.get(editorViewCtx);
        const handlePaste = async (e: ClipboardEvent) => {
          const file = firstClipboardImage(e.clipboardData);
          if (!file || !callbacks.onImagePaste) return;
          e.preventDefault();
          const original = view.state;
          const isCurrent = callbacks.captureImagePaste?.();
          try {
            const imagePath = await callbacks.onImagePaste(file);
            if (!imagePath || !view.dom.isConnected || view.isDestroyed || view.state !== original
              || isCurrent?.() === false) return;
            const { state, dispatch } = view;
            // 插入真正的 image 节点而非纯文本,否则 Markdown 不会渲染成图片。
            const imageType = state.schema.nodes.image;
            if (imageType) {
              const node = imageType.create({ src: imagePath, alt: '', title: '' });
              dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
            } else {
              dispatch(state.tr.insertText(`![](${imagePath})`));
            }
          } catch (err) {
            console.error('粘贴图片失败', err);
          }
        };

        // Capture before ProseMirror consumes the text/HTML part of mixed clipboard data.
        view.dom.addEventListener('paste', handlePaste, true);
        removePasteListener = () => view.dom.removeEventListener('paste', handlePaste, true);
      }, 100);
    });
  }

  return editor;
}

/** 获取当前文档的完整状态(用于挂载后初始化大纲与统计) */
export function getCurrentState(editor: Editor): EditorUpdate {
  const markdown = editor.action((ctx: Ctx) => utilsGetMarkdown()(ctx));
  const { outline, canUndo, canRedo } = editor.action((ctx: Ctx) => {
    const view = ctx.get(editorViewCtx);
    return {
      outline: extractOutline(view.state.doc),
      ...historyState(view.state),
    };
  });
  return { markdown, outline, stats: computeStats(markdown), canUndo, canRedo };
}

/** 用 Markdown 字符串替换整个文档内容(用于外部重新加载 / 源码模式切换) */
export function setMarkdown(editor: Editor, markdown: string): void {
  editor.action((ctx: Ctx) => {
    const parser = ctx.get(parserCtx);
    const view = ctx.get(editorViewCtx);
    const doc = parser(markdown);
    if (!doc) return;
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    // 光标定位到新文档开头(不能复用旧文档的 selection)
    tr.setSelection(TextSelection.atStart(tr.doc));
    view.dispatch(tr);
    view.focus();
  });
}

/** 撤销 */
export function undo(editor: Editor): void {
  editor.action((ctx: Ctx) => {
    const view = ctx.get(editorViewCtx);
    pmUndo(view.state, view.dispatch);
  });
}

/** 重做 */
export function redo(editor: Editor): void {
  editor.action((ctx: Ctx) => {
    const view = ctx.get(editorViewCtx);
    pmRedo(view.state, view.dispatch);
  });
}
