import type { DocStats } from './types';

/**
 * 计算文档统计信息。
 *
 * - `chars`：去掉所有空白后的字符数
 * - `words`：中文字符数 + 英文单词数（中文不分词，逐字计）
 * - `lines`：按 \n 切分的行数，空文档记为 1 行
 *
 * 富文本模式和源码模式都必须走这里，否则两种模式的统计口径会不一致。
 */
export function computeStats(markdown: string): DocStats {
  const text = markdown.replace(/\s/g, '');
  const chineseChars = (text.match(/[一-龥]/g) || []).length;
  const englishWords = (markdown.match(/[a-zA-Z]+/g) || []).length;

  return {
    chars: text.length,
    words: chineseChars + englishWords,
    lines: markdown.split('\n').length,
  };
}
