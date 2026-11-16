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
  closeHistory,
} from '@milkdown/prose/history';
import { Plugin, PluginKey, Selection, type EditorState } from '@milkdown/prose/state';
import { Fragment } from '@milkdown/prose/model';
import { commonmark, imageSchema, headingIdGenerator } from '@milkdown/kit/preset/commonmark';
import { Transform } from '@milkdown/prose/transform';
import { gfm, keepTableAlignPlugin } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';

import { $prose, $view, getMarkdown as utilsGetMarkdown } from '@milkdown/kit/utils';
import { math, katexOptionsCtx, mathInlineSchema, mathBlockSchema } from '@milkdown/plugin-math';
import katex from 'katex';
import { prism } from '@milkdown/plugin-prism';
import { nord } from '@milkdown/theme-nord';
import { mermaidPlugin } from './mermaid';
import { searchPlugin } from './search';
import { computeStats } from './stats';
import { taskListPlugin } from './tasklist';
import { firstClipboardImage } from './sourcePaste';
import {
  cacheMarkdownParser,
  cachedDocSchema,
  configureMarkdownSchemas,
  createSimpleDocument,
} from './markdownSchemas';
import { imageLayoutPlugin, imageSelectionPlugin } from './imageLayout';
import { imageMarqueePlugin } from './imageMarquee';
import { imageView } from './imageView';
import type { MediaPreview } from './media';
import type { EditorUpdate, OutlineItem } from './types';
import { isComposingEvent } from './shortcuts';
import { createNodeIndex } from './documentNodes';
import { configurePrismTransactions, createTableAlignmentPlugin } from './editorPerformance';
import { flushEditorUpdate, pendingEditorUpdates } from './editorUpdates';
import { TAB_RENDER_MS } from '../config/constants';

const synchronization = new PluginKey<boolean>('mdplus-synchronization');
const insertionPositions = new PluginKey<ReadonlyMap<object, number>>('mdplus-insertion-positions');
type PositionOperation = { add: object; position: number } | { remove: object };

/** Positions belong to one live editor and map through every real transaction,
 * including input, undo, reload and image migrations during asynchronous I/O. */
const insertionPositionPlugin = new Plugin<ReadonlyMap<object, number>>({
  key: insertionPositions,
  state: {
    init: () => new Map(),
    apply: (transaction, previous) => {
      if (!transaction.docChanged && !transaction.getMeta(insertionPositions)) return previous;
      const positions = new Map(
        [...previous].map(([key, position]) => [key, transaction.mapping.map(position, 1)]),
      );
      const operation = transaction.getMeta(insertionPositions) as PositionOperation | undefined;
      if (operation && 'add' in operation) positions.set(operation.add, operation.position);
      else if (operation) positions.delete(operation.remove);
      return positions;
    },
  },
});
/** 编辑器更新回调 */
export interface EditorCallbacks {
  onUpdate: (update: EditorUpdate, coalesced?: boolean) => void;
  onActivity?: (update: Pick<EditorUpdate, 'canUndo' | 'canRedo'>) => void;
  /** Coalesce derived Markdown work; immediate activity still records every edit. */
  deferUpdates?: boolean;
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
  onDocumentLink?: (href: string) => void;
}

/** 从 ProseMirror doc 提取标题大纲 */
const headingNodes = createNodeIndex('heading');
const imageNodes = createNodeIndex('image');
function extractOutline(doc: import('@milkdown/prose/model').Node): OutlineItem[] {
  return headingNodes(doc).map(({ node, pos }) => ({
    level: node.attrs.level as number,
    text: node.textContent,
    pos,
  }));
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
      const simpleDocument = createSimpleDocument(content);
      ctx.set(defaultValueCtx, simpleDocument ? { type: 'json', value: simpleDocument } : content);
      ctx.set(katexOptionsCtx.key, { throwOnError: true, trust: false });
      for (const mathSchema of [mathInlineSchema, mathBlockSchema]) {
        ctx.update(mathSchema.key, (original) => (ctx) => {
          const schema = original(ctx);
          return {
            ...schema,
            toDOM: (node) => {
              try {
                return schema.toDOM!(node);
              } catch (error) {
                if (!(error instanceof katex.ParseError)) throw error;
                const code = mathSchema === mathInlineSchema ? node.textContent : node.attrs.value;
                const dom = document.createElement(
                  mathSchema === mathInlineSchema ? 'span' : 'div',
                );
                dom.dataset.type = node.type.name;
                dom.dataset.value = code;
                const message = document.createElement('span');
                message.className = 'katex-error';
                message.textContent = `公式有误：${code}`;
                message.setAttribute('role', 'alert');
                message.title = error.message;
                message.style.color = 'var(--danger)';
                dom.append(message);
                return dom;
              }
            },
          };
        });
      }
    })
    .config(configureMarkdownSchemas)
    .config(configurePrismTransactions)
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
    .use(
      gfm.map((plugin) =>
        plugin === keepTableAlignPlugin ? $prose(createTableAlignmentPlugin) : plugin,
      ),
    )
    .use(cachedDocSchema)
    .use(history)
    .use(
      $prose(
        () =>
          new Plugin({
            props: {
              handleDOMEvents: {
                click: (view, event) => {
                  const link =
                    event.target instanceof Element ? event.target.closest('a[href]') : null;
                  if (!link || !view.dom.contains(link)) return false;
                  event.preventDefault();
                  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey)
                    return false;
                  callbacks.onDocumentLink?.(link.getAttribute('href') ?? '');
                  return true;
                },
              },
              handleKeyDown: (view, event) => {
                if (
                  isComposingEvent(event) ||
                  event.key !== 'Enter' ||
                  !event.ctrlKey ||
                  event.altKey ||
                  event.shiftKey ||
                  event.metaKey ||
                  !view.state.selection.empty
                )
                  return false;
                const link = view.state.selection.$from
                  .marks()
                  .find((mark) => mark.type.name === 'link');
                if (!link || typeof link.attrs.href !== 'string') return false;
                event.preventDefault();
                if (!event.repeat) callbacks.onDocumentLink?.(link.attrs.href);
                return true;
              },
            },
          }),
      ),
    )
    .use($prose(() => insertionPositionPlugin))
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
              if (!callbacks.resolveImageIdentity || !transactions.some((item) => item.docChanged))
                return null;
              const tr = state.tr;
              for (const { node, pos } of imageNodes(state.doc)) {
                const src = callbacks.resolveImageIdentity!(node.attrs.src);
                if (src !== node.attrs.src)
                  tr.setNodeMarkup(pos, undefined, { ...node.attrs, src });
              }
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
              const restoreParser = cacheMarkdownParser(ctx);
              const normalize = () => {
                if (!callbacks.resolveImageIdentity || view.isDestroyed) return;
                const tr = view.state.tr;
                for (const { node, pos } of imageNodes(view.state.doc)) {
                  const src = callbacks.resolveImageIdentity!(node.attrs.src);
                  if (src !== node.attrs.src)
                    tr.setNodeMarkup(pos, undefined, { ...node.attrs, src });
                }
                if (tr.docChanged)
                  view.dispatch(tr.setMeta(synchronization, true).setMeta('addToHistory', false));
              };
              const unsubscribe = callbacks.subscribeImageSources?.(normalize);
              // Text-only edits preserve reachability; undo/redo branch changes require a fresh scan.
              let previousImages = imageNodes(view.state.doc).map(({ node }) =>
                String(node.attrs.src),
              );
              let previousUndoDepth = undoDepth(view.state);
              let previousRedoDepth = redoDepth(view.state);
              return {
                update: (view, previous) => {
                  if (
                    view.state.doc !== previous.doc ||
                    imageHistoryKey?.getState(view.state) !== imageHistoryKey?.getState(previous)
                  ) {
                    const images = imageNodes(view.state.doc).map(({ node }) =>
                      String(node.attrs.src),
                    );
                    const imagesChanged =
                      images.length !== previousImages.length ||
                      images.some((src, index) => src !== previousImages[index]);
                    const undoDepthNow = undoDepth(view.state);
                    const redoDepthNow = redoDepth(view.state);
                    const historyNavigation =
                      undoDepthNow < previousUndoDepth || redoDepthNow !== previousRedoDepth;
                    if (imagesChanged || historyNavigation) callbacks.onImageReferencesChanged?.();
                    previousImages = images;
                    previousUndoDepth = undoDepthNow;
                    previousRedoDepth = redoDepthNow;
                  }
                  if (synchronization.getState(view.state)) return;
                  if (view.state.doc.eq(previous.doc)) return;
                  const publish = (coalesced = false) => {
                    if (view.isDestroyed) return;
                    const markdown = ctx.get(serializerCtx)(view.state.doc);
                    const update = {
                      markdown,
                      outline: extractOutline(view.state.doc),
                      stats: computeStats(markdown),
                      ...historyState(view.state),
                    };
                    if (coalesced) callbacks.onUpdate(update, true);
                    else callbacks.onUpdate(update);
                  };
                  if (callbacks.deferUpdates && callbacks.onActivity) {
                    if (!pendingEditorUpdates.has(editor)) {
                      const timer = setTimeout(() => flushEditorUpdate(editor), TAB_RENDER_MS);
                      pendingEditorUpdates.set(editor, { timer, publish: () => publish(true) });
                    }
                    callbacks.onActivity(historyState(view.state));
                    return;
                  }
                  publish();
                },
                destroy: () => {
                  const pending = pendingEditorUpdates.get(editor);
                  if (pending) {
                    clearTimeout(pending.timer);
                    pendingEditorUpdates.delete(editor);
                  }
                  unsubscribe?.();
                  restoreParser();
                },
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
    .use($prose(() => imageSelectionPlugin))
    .use($prose(() => imageMarqueePlugin))
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

/** 获取当前文档状态；已有原文时无需为初始化再次序列化。 */
export function getCurrentState(editor: Editor, sourceMarkdown?: string): EditorUpdate {
  const markdown = sourceMarkdown ?? editor.action((ctx: Ctx) => utilsGetMarkdown()(ctx));
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
    for (const { node, pos } of imageNodes(view.state.doc)) {
      const next = doc.nodeAt(pos);
      if (next?.type === node.type && !next.eq(node))
        tr.setNodeMarkup(pos, undefined, next.attrs, next.marks);
    }
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

export interface EditorPositionLease {
  read: () => number | null;
  release: () => void;
}

/** Capture synchronously before reading image bytes. Hidden tabs retain their
 * editor; closing/destroying it invalidates this lease rather than redirecting it. */
export function trackEditorPosition(editor: Editor, position: number): EditorPositionLease | null {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (view.isDestroyed || !view.dom.isConnected || !insertionPositions.getState(view.state))
      return null;
    const key = {};
    const at = Math.max(0, Math.min(view.state.doc.content.size, position));
    view.dispatch(
      view.state.tr
        .setMeta(insertionPositions, { add: key, position: at } satisfies PositionOperation)
        .setMeta('addToHistory', false),
    );
    let released = false;
    return {
      read: () =>
        released || view.isDestroyed || !view.dom.isConnected
          ? null
          : (insertionPositions.getState(view.state)?.get(key) ?? null),
      release: () => {
        if (released) return;
        released = true;
        if (!view.isDestroyed)
          view.dispatch(
            view.state.tr
              .setMeta(insertionPositions, { remove: key } satisfies PositionOperation)
              .setMeta('addToHistory', false),
          );
      },
    };
  });
}

export interface ImageInsertion {
  src: string;
  alt?: string;
  title?: string;
}

/** Insert the whole batch in one isolated history event, with schema-valid
 * inline images or a paragraph when the original textblock forbids images. */
export function insertImageBatchAt(
  editor: Editor,
  position: number,
  images: readonly ImageInsertion[],
  foreground = false,
): boolean {
  if (!images.length || images.some((image) => !image.src)) return false;
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (view.isDestroyed || !view.dom.isConnected || view.composing) return false;
    const state = view.state;
    const imageType = state.schema.nodes.image;
    const paragraphType = state.schema.nodes.paragraph;
    if (!imageType || !paragraphType || position < 0 || position > state.doc.content.size)
      return false;
    try {
      const fragment = Fragment.fromArray(
        images.map((image) =>
          imageType.create({ src: image.src, alt: image.alt ?? '', title: image.title ?? '' }),
        ),
      );
      const $position = state.doc.resolve(position);
      const tr = state.tr;
      if ($position.parent.isTextblock) {
        const offset = $position.parentOffset;
        const content = $position.parent.content
          .cut(0, offset)
          .append(fragment)
          .append($position.parent.content.cut(offset));
        if ($position.parent.type.validContent(content)) tr.insert(position, fragment);
        else {
          // For code/plain-text blocks, keep both sides with their original
          // node attributes and marks, and put real images between paragraphs.
          const before = $position.parent.cut(0, offset);
          const after = $position.parent.cut(offset);
          tr.replaceWith(
            $position.before(),
            $position.after(),
            Fragment.fromArray([
              ...(before.content.size ? [before] : []),
              paragraphType.create(null, fragment),
              ...(after.content.size ? [after] : []),
            ]),
          );
        }
      } else tr.replaceRangeWith(position, position, paragraphType.create(null, fragment));
      if (!tr.docChanged || tr.doc.textContent !== state.doc.textContent) return false;
      tr.doc.check();
      if (foreground) {
        // Mapping gives the boundary after a plain inline insertion. For a
        // split block use the last image's actual new position instead.
        let end = tr.mapping.map(position, 1);
        const sources = new Set(images.map((image) => image.src));
        tr.doc.descendants((node, pos) => {
          if (node.type === imageType && sources.has(node.attrs.src)) end = pos + node.nodeSize;
        });
        tr.setSelection(Selection.near(tr.doc.resolve(end), 1)).scrollIntoView();
      }
      view.dispatch(closeHistory(tr));
      // A second, non-history boundary keeps immediately following typing out
      // of the drop's one-step undo event, even inside the coalescing window.
      view.dispatch(closeHistory(view.state.tr).setMeta('addToHistory', false));
      if (foreground) view.focus();
      return true;
    } catch (error) {
      console.warn('图片批量插入失败', error);
      return false;
    }
  });
}

const reachableImages = new WeakMap<
  Editor,
  { doc: EditorState['doc']; history: unknown; urls: ReadonlySet<string> }
>();
const imageHistoryKey = pmHistory().spec.key;
/** Read history through public commands on isolated states; never run live editor plugins. */
export function getEditorImageReferences(editor: Editor): ReadonlySet<string> {
  return editor.action((ctx) => {
    const state = ctx.get(editorViewCtx).state;
    const history = imageHistoryKey?.getState(state);
    const cached = reachableImages.get(editor);
    if (cached?.doc === state.doc && cached.history === history) return cached.urls;
    const urls = new Set<string>();
    const collect = (current: EditorState) => {
      for (const { node } of imageNodes(current.doc)) urls.add(node.attrs.src);
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
    reachableImages.set(editor, { doc: state.doc, history, urls });
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
