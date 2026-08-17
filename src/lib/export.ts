import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from './fileOps';

/**
 * 提取当前活动标签的渲染结果,包装为独立 HTML。
 *
 * 所有标签页都挂载在 DOM 中(非活动标签仅靠 CSS `display:none` 隐藏),
 * 因此必须限定 `.editor-tab.active`——直接查 `.milkdown` 会恒定命中
 * 文档里第一个标签,从第二个标签导出就会导出错的内容。
 */
export function markdownToHTML(title: string): string {
  const editorContent =
    document.querySelector('.editor-tab.active .milkdown')?.innerHTML ??
    document.querySelector('.milkdown')?.innerHTML ??
    '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)}</title>
  <style>
    body {
      max-width: 800px;
      margin: 40px auto;
      padding: 0 20px;
      font-family: -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
      color: #333;
    }
    h1, h2, h3, h4, h5, h6 {
      margin-top: 24px;
      margin-bottom: 16px;
      font-weight: 600;
      line-height: 1.25;
    }
    h1 { font-size: 2em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
    h3 { font-size: 1.25em; }
    code {
      background: #f6f8fa;
      padding: 0.2em 0.4em;
      border-radius: 3px;
      font-family: "JetBrains Mono", Consolas, monospace;
      font-size: 0.9em;
    }
    pre {
      background: #f6f8fa;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
    }
    pre code {
      background: none;
      padding: 0;
    }
    blockquote {
      border-left: 4px solid #ddd;
      padding-left: 16px;
      margin-left: 0;
      color: #666;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 16px 0;
    }
    table th, table td {
      border: 1px solid #ddd;
      padding: 8px 12px;
      text-align: left;
    }
    table th {
      background: #f6f8fa;
      font-weight: 600;
    }
    img {
      max-width: 100%;
      height: auto;
    }
    a {
      color: #0969da;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    @media print {
      body { margin: 0; padding: 20px; }
    }
  </style>
</head>
<body>
${editorContent}
</body>
</html>`;
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** 导出为 HTML 文件 */
export async function exportHTML(title: string): Promise<void> {
  const html = markdownToHTML(title);

  const path = await save({
    defaultPath: `${title}.html`,
    filters: [
      { name: 'HTML', extensions: ['html'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    title: '导出 HTML',
  });

  if (path) {
    await writeFile(path, html);
  }
}

/** 导出为 PDF（使用浏览器打印功能）*/
export async function exportPDF(): Promise<void> {
  // 隐藏工具栏和其他非内容元素。
  // 注意大纲栏的真实类名是 `.outline`(OutlinePanel 渲染的 <aside>),不是 `.outline-panel`。
  const toolbar = document.querySelector('.toolbar');
  const tabbar = document.querySelector('.tabbar');
  const statusbar = document.querySelector('.statusbar');
  const outline = document.querySelector('.outline');

  const elementsToHide = [toolbar, tabbar, statusbar, outline].filter(Boolean) as HTMLElement[];
  elementsToHide.forEach(el => el.style.display = 'none');

  // 添加打印样式。非活动标签由 `.editor-tab` 的基础样式(display:none)隐藏,
  // 这里只需去掉正文内边距限制。
  const printStyle = document.createElement('style');
  printStyle.id = 'print-style';
  printStyle.textContent = `
    @media print {
      .milkdown { padding: 20px; }
    }
  `;
  document.head.appendChild(printStyle);

  // 触发打印对话框。优先等待 afterprint，避免对话框仍打开时提前恢复界面。
  await new Promise<void>((resolve) => {
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      window.removeEventListener('afterprint', restore);
      elementsToHide.forEach((el) => (el.style.display = ''));
      printStyle.remove();
      resolve();
    };

    window.addEventListener('afterprint', restore, { once: true });
    try {
      window.print();
    } catch (error) {
      restore();
      throw error;
    }
    // 某些 WebView 不派发 afterprint，保留兜底恢复。
    window.setTimeout(restore, 10000);
  });
}
