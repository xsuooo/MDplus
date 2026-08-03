/** 新建文档的内置模板 */

export const BLANK_TEMPLATE = '';

export const BASIC_TEMPLATE = `# MDPlus 入门指南

欢迎使用 **MDPlus** —— 一个所见即所得的 Markdown 编辑器。直接输入即渲染,无需关心源码语法。

## 功能速览

- **所见即所得**:输入即渲染,编辑效果即为最终效果
- **自动保存**:停止输入 1.5 秒后自动写入磁盘
- **源码模式**:工具栏一键切换源码与渲染视图

### 任务清单

- [x] 已支持任务清单(点击复选框可切换状态)
- [ ] 待办事项示例

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

## Mermaid 图表

\`\`\`mermaid
graph TD
    A[开始] --> B{是否准备就绪?}
    B -->|是| C[开始写作]
    B -->|否| D[先浏览本指南]
    C --> E[享受 MDPlus!]
    D --> C
\`\`\`

## 表格

| 功能 | 支持情况 |
| ---- | -------- |
| 基础语法 | ✅ |
| Mermaid 图表 | ✅ |
| LaTeX 公式 | ✅ |
| 任务清单 | ✅ |
| 代码高亮 | ✅ |

> **小提示**:直接清空本页,开始书写你的第一篇文档吧。
`;

/** 获取模板:kind 为 blank | basic */
export function getTemplate(kind: 'blank' | 'basic'): string {
  return kind === 'blank' ? BLANK_TEMPLATE : BASIC_TEMPLATE;
}
