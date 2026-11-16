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
  let chars = 0;
  let words = 0;
  let lines = 1;
  let inWord = false;
  for (let index = 0; index < markdown.length; index++) {
    const code = markdown.charCodeAt(index);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if ((letter && !inWord) || (code >= 0x4e00 && code <= 0x9fa5)) words++;
    inWord = letter;
    if (code === 10) lines++;
    // Match JavaScript \s without allocating whole-document replacements or match arrays.
    if (!(
      code === 32 ||
      (code >= 9 && code <= 13) ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000 ||
      code === 0xfeff
    ))
      chars++;
  }

  return { chars, words, lines };
}
