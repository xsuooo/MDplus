import {
  Editor,
  rootCtx,
  defaultValueCtx,
  parserCtx,
  editorViewCtx,
} from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import {
  undo as pmUndo,
  redo as pmRedo,
  undoDepth,
  redoDepth,
} from '@milkdown/prose/history';
import { TextSelection } from '@milkdown/prose/state';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { $prose, getMarkdown as utilsGetMarkdown } from '@milkdown/kit/utils';
import { math } from '@milkdown/plugin-math';
import { prism } from '@milkdown/plugin-prism';
import { nord } from '@milkdown/theme-nord';
import { mermaidPlugin } from './mermaid';
import { searchPlugin } from './search';
import { computeStats } from './stats';
import { taskListPlugin } from './tasklist';
import type { EditorUpdate, OutlineItem } from './types';

/** 编辑器更新回调 */
export interface EditorCallbacks {
  onUpdate: (update: EditorUpdate) => void;
  onImagePaste?: (file: File) => Promise<string>;
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

      let lastOutline: OutlineItem[] = [];

      ctx.get(listenerCtx)
        .updated((_ctx, doc) => {
          lastOutline = extractOutline(doc);
        })
        .markdownUpdated((ctx, markdown) => {
          const view = ctx.get(editorViewCtx);
          callbacks.onUpdate({
            markdown,
            outline: lastOutline,
            stats: computeStats(markdown),
            ...historyState(view.state),
          });
        });
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(listener)
    .use(math)
    .use(prism)
    .use(nord as unknown as import('@milkdown/kit/ctx').MilkdownPlugin)
    .use(mermaidPlugin)
    .use($prose(() => searchPlugin))
    .use($prose(() => taskListPlugin));

  // 添加图片粘贴支持
  if (callbacks.onImagePaste) {
    editor.config((ctx) => {
      ctx.get(editorViewCtx);
      // 在编辑器挂载后添加粘贴监听
      setTimeout(() => {
        const view = ctx.get(editorViewCtx);
        const handlePaste = async (e: ClipboardEvent) => {
          const items = e.clipboardData?.items;
          if (!items || !callbacks.onImagePaste) return;

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
              e.preventDefault();
              const file = item.getAsFile();
              if (!file) continue;

              try {
                const imagePath = await callbacks.onImagePaste(file);
                const { state, dispatch } = view;
                const imageMarkdown = `![](${imagePath})`;
                const transaction = state.tr.insertText(imageMarkdown);
                dispatch(transaction);
              } catch (err) {
                console.error('粘贴图片失败', err);
              }
              break;
            }
          }
        };

        view.dom.addEventListener('paste', handlePaste);
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
