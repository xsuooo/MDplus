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
  history as pmHistory,
  undo as pmUndo,
  redo as pmRedo,
  undoDepth,
  redoDepth,
} from '@milkdown/prose/history';
import { Plugin, PluginKey, Selection, type EditorState } from '@milkdown/prose/state';
import { commonmark, imageSchema, headingIdGenerator } from '@milkdown/kit/preset/commonmark';
import { Transform } from '@milkdown/prose/transform';
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
import { imageLayoutPlugin } from './imageLayout';
import { imageView } from './imageView';
import type { MediaPreview } from './media';
import type { EditorUpdate, OutlineItem } from './types';

const synchronization = new PluginKey<boolean>('mdplus-synchronization');
/** 编辑器更新回调 */
export interface EditorCallbacks {
  onUpdate: (update: EditorUpdate) => void;
  onImagePaste?: (file: File) => Promise<string>;
  resolveImageSource?: (url: string) => string;
  subscribeImageSources?: (listener: () => void) => () => void;
  /** Rich document/history attributes use identities; only serialization exposes safe disk URLs. */
  resolveImageIdentity?: (url: string) => string;
  resolveImageReference?: (token: string) => string;
  onImageReferencesChanged?: () => void;
  onImagePasteSettled?: (token: string) => void;
  captureImagePaste?: () => () => boolean;
  onMediaPreview?: (media: MediaPreview) => void;
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
function historyState(doc: import('@milkdown/prose/state').EditorState): {
  canUndo: boolean;
  canRedo: boolean;
} {
  try {
    return { canUndo: undoDepth(doc) > 0, canRedo: redoDepth(doc) > 0 };
  } catch {
    return { canUndo: false, canRedo: false };
  }
}

/** 构建 Milkdown 编辑器 */
export function createEditor(
  root: HTMLElement,
  content: string,
  callbacks: EditorCallbacks,
): Editor {
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, content);
    })
    .config(configureMarkdownSchemas)
    .config((ctx) => {
      if (!callbacks.resolveImageIdentity && !callbacks.resolveImageReference) return;
      ctx.update(imageSchema.key, (original) => (ctx) => {
        const schema = original(ctx);
        return {
          ...schema,
          parseDOM: schema.parseDOM?.map((rule) => {
            if (!('tag' in rule) || !rule.getAttrs) return rule;
            const getAttrs = rule.getAttrs;
            return {
              ...rule,
              getAttrs: (dom: HTMLElement) => {
                const attrs = getAttrs(dom);
                if (!attrs) return attrs;
                return { ...attrs, src: callbacks.resolveImageIdentity?.(attrs.src) ?? attrs.src };
              },
            };
          }),
          toDOM: schema.toDOM
            ? (node) => {
                const src = callbacks.resolveImageReference?.(node.attrs.src) ?? node.attrs.src;
                return schema.toDOM!(
                  src === node.attrs.src
                    ? node
                    : node.type.create({ ...node.attrs, src }, node.content, node.marks),
                );
              }
            : undefined,
          parseMarkdown: {
            ...schema.parseMarkdown,
            runner: (state, node, type) =>
              schema.parseMarkdown.runner(
                state,
                {
                  ...node,
                  url: callbacks.resolveImageIdentity?.(String(node.url ?? '')) ?? node.url,
                },
                type,
              ),
          },
          toMarkdown: {
            ...schema.toMarkdown,
            runner: (state, node) => {
              const src = callbacks.resolveImageReference?.(node.attrs.src) ?? node.attrs.src;
              schema.toMarkdown.runner(
                state,
                src === node.attrs.src
                  ? node
                  : node.type.create({ ...node.attrs, src }, node.content, node.marks),
              );
            },
          },
        };
      });
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    // Milkdown 的 listener 会防抖 200ms，不能作为保存/关闭的内容源。
    // view.update 在事务提交后同步执行；仅 UI 渲染仍由 App 节流。
    .use(
      $prose(
        (ctx) =>
          new Plugin({
            key: synchronization,
            state: {
              init: () => false,
              apply: (transaction) => transaction.getMeta(synchronization) === true,
            },
            appendTransaction: (transactions, _previous, state) => {
              if (!callbacks.resolveImageIdentity) return null;
              const tr = state.tr;
              state.doc.descendants((node, pos) => {
                if (node.type.name !== 'image') return;
                const src = callbacks.resolveImageIdentity!(node.attrs.src);
                if (src !== node.attrs.src)
                  tr.setNodeMarkup(pos, undefined, { ...node.attrs, src });
              });
              if (!tr.docChanged) return null;
              // Join a user insertion's history event, so its redo stores the token,
              // not a directory-dependent raw URL. Silent sync stays non-history.
              const silent = transactions.every((item) => item.getMeta(synchronization) === true);
              tr.setMeta(synchronization, silent);
              if (transactions.every((item) => item.getMeta('addToHistory') === false))
                tr.setMeta('addToHistory', false);
              return tr;
            },
            view: (view) => {
              const normalize = () => {
                if (!callbacks.resolveImageIdentity || view.isDestroyed) return;
                const tr = view.state.tr;
                view.state.doc.descendants((node, pos) => {
                  if (node.type.name !== 'image') return;
                  const src = callbacks.resolveImageIdentity!(node.attrs.src);
                  if (src !== node.attrs.src)
                    tr.setNodeMarkup(pos, undefined, { ...node.attrs, src });
                });
                if (tr.docChanged)
                  view.dispatch(tr.setMeta(synchronization, true).setMeta('addToHistory', false));
              };
              const unsubscribe = callbacks.subscribeImageSources?.(normalize);
              return {
                update: (view, previous) => {
                  if (view.state !== previous) callbacks.onImageReferencesChanged?.();
                  if (synchronization.getState(view.state)) return;
                  if (view.state.doc.eq(previous.doc)) return;
                  const markdown = ctx.get(serializerCtx)(view.state.doc);
                  callbacks.onUpdate({
                    markdown,
                    outline: extractOutline(view.state.doc),
                    stats: computeStats(markdown),
                    ...historyState(view.state),
                  });
                },
                destroy: () => unsubscribe?.(),
              };
            },
          }),
      ),
    )
    .use(math)
    .use(prism)
    .use(nord as unknown as import('@milkdown/kit/ctx').MilkdownPlugin)
    .use(mermaidPlugin(callbacks.onMediaPreview))
    .use($prose(() => searchPlugin))
    .use($prose(() => imageLayoutPlugin))
    .use($prose(() => taskListPlugin));

  editor.use(
    $view(imageSchema.node, () =>
      imageView(
        callbacks.resolveImageSource ?? ((src) => src),
        callbacks.onMediaPreview,
        callbacks.subscribeImageSources,
      ),
    ),
  );

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
          let imagePath = '';
          try {
            imagePath = await callbacks.onImagePaste(file);
            if (
              !imagePath ||
              !view.dom.isConnected ||
              view.isDestroyed ||
              view.state !== original ||
              isCurrent?.() === false
            )
              return;
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
          } finally {
            if (imagePath) callbacks.onImagePasteSettled?.(imagePath);
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

/** 局部同步 Markdown，不抢焦点；调用方接收派生状态，避免把同步当成新输入。 */
export function setMarkdown(editor: Editor, markdown: string, addToHistory = true): EditorUpdate {
  editor.action((ctx: Ctx) => {
    const parser = ctx.get(parserCtx);
    const view = ctx.get(editorViewCtx);
    const parsed = parser(markdown);
    if (!parsed) return;
    const normalized = new Transform(parsed);
    const headingId = ctx.get(headingIdGenerator.key);
    parsed.descendants((node, pos) => {
      if (node.type.name === 'heading')
        normalized.setNodeMarkup(pos, undefined, { ...node.attrs, id: headingId(node) });
    });
    const doc = normalized.doc;
    if (doc.eq(view.state.doc)) return;
    const scroller = view.dom.closest<HTMLElement>('.milkdown-container');
    const top = scroller?.scrollTop;
    const left = scroller?.scrollLeft;
    // Saving pasted images changes attributes, not document structure or selection.
    let tr = view.state.tr;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return;
      const next = doc.nodeAt(pos);
      if (next?.type === node.type && !next.eq(node))
        tr.setNodeMarkup(pos, undefined, next.attrs, next.marks);
    });
    if (tr.doc.eq(doc)) {
      tr.setSelection(Selection.fromJSON(tr.doc, view.state.selection.toJSON()));
    } else {
      const start = view.state.doc.content.findDiffStart(doc.content);
      const end = view.state.doc.content.findDiffEnd(doc.content);
      if (start == null || !end) return;
      const overlap = start - Math.min(end.a, end.b);
      if (overlap > 0) {
        end.a += overlap;
        end.b += overlap;
      }
      tr = view.state.tr.replace(start, end.a, doc.slice(start, end.b));
    }
    tr.setMeta(synchronization, true).setMeta('addToHistory', addToHistory);
    view.dispatch(tr);
    if (scroller && top !== undefined && left !== undefined) {
      scroller.scrollTop = top;
      scroller.scrollLeft = left;
    }
  });
  return getCurrentState(editor);
}

const reachableImages = new WeakMap<EditorState, ReadonlySet<string>>();
const imageHistoryKey = pmHistory().spec.key;
/** Read history through public commands on isolated states; never run live editor plugins. */
export function getEditorImageReferences(editor: Editor): ReadonlySet<string> {
  return editor.action((ctx) => {
    const state = ctx.get(editorViewCtx).state;
    const cached = reachableImages.get(state);
    if (cached) return cached;
    const urls = new Set<string>();
    const collect = (current: EditorState) => {
      current.doc.descendants((node) => {
        if (node.type.name === 'image') urls.add(node.attrs.src);
      });
    };
    collect(state);
    // Keep the original history plugin/configuration and its immutable state field.
    // Other plugins can have side effects: Milkdown's tracker writes editorStateCtx
    // even when apply() is called on a shadow rather than the visible editor state.
    const historyPlugin = imageHistoryKey?.get(state);
    const isolated = state.reconfigure({ plugins: historyPlugin ? [historyPlugin] : [] });
    for (const [command, depth] of [
      [pmUndo, undoDepth(isolated)],
      [pmRedo, redoDepth(isolated)],
    ] as const) {
      let shadow = isolated;
      for (let remaining = depth; remaining > 0; remaining--) {
        if (
          !command(shadow, (transaction) => {
            shadow = shadow.apply(transaction);
          })
        )
          break;
        collect(shadow);
      }
    }
    reachableImages.set(state, urls);
    return urls;
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
