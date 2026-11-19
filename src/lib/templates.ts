/** 新建文档的内置模板 */

export const BLANK_TEMPLATE = '';

export const BASIC_TEMPLATE = `# Markdown 示例

直接编辑这份示例，体验 **加粗**、*斜体* 和 [链接](https://example.com)。

## 任务清单

- [x] 写下第一个想法
- [ ] 整理笔记

## 代码高亮

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

console.log(greet("MDPlus"));
\`\`\`

## 数学公式

行内公式:欧拉恒等式 $e^{i\\pi} + 1 = 0$

块级公式:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

## 流程图

\`\`\`mermaid
graph TD
    A[写作] --> B[保存]
    B --> C[继续编辑]
\`\`\`

## 表格

| 日期 | 计划 |
| ---- | ---- |
| 周一 | 阅读 |
| 周二 | 写作 |
`;

/** 获取模板:kind 为 blank | basic */
export function getTemplate(kind: 'blank' | 'basic'): string {
  return kind === 'blank' ? BLANK_TEMPLATE : BASIC_TEMPLATE;
}
