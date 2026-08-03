import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { Node as PMNode } from '@milkdown/prose/model';

/**
 * 任务清单复选框插件。
 * 为 checked 属性为布尔值的 list_item 节点渲染可点击的复选框,
 * 点击后通过事务更新 checked 属性,并同步回 Markdown 文档。
 */
const key = new PluginKey<DecorationSet>('mdplus-tasklist');

function buildDecos(doc: PMNode): DecorationSet {
  const decos: ReturnType<typeof Decoration.widget>[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'list_item' && typeof node.attrs.checked === 'boolean') {
      const checked = node.attrs.checked as boolean;
      decos.push(
        Decoration.widget(
          pos + 1,
          (view) => {
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.name = 'mdplus-task';
            box.className = 'md-task-checkbox';
            box.checked = checked;
            box.addEventListener('change', () => {
              view.dispatch(
                view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: box.checked }),
              );
              view.focus();
            });
            return box;
          },
          { key: `task-${pos}-${checked}` },
        ),
      );
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

export const taskListPlugin = new Plugin({
  key,
  state: {
    // 编辑器挂载 defaultValue 不产生 docChanged 事务,
    // 必须在 init 时基于初始 doc 构建装饰,否则打开文档时复选框不渲染
    init: (config) => {
      const doc = config.doc;
      return doc ? buildDecos(doc) : DecorationSet.empty;
    },
    apply(tr, prev) {
      if (tr.docChanged) return buildDecos(tr.doc);
      return prev;
    },
  },
  props: {
    decorations(state) {
      return key.getState(state) ?? DecorationSet.empty;
    },
  },
});
