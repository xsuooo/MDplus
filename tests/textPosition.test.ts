import { describe, expect, it } from 'vitest';
import { mapTextOffset } from '../src/lib/textPosition';
import { mapImageOffset, rewriteImageReferences } from '../src/lib/imagePaths';

describe('source selection rebasing', () => {
  it('maps offsets through a preceding edit and clamps a removed selection', () => {
    expect(mapTextOffset('abc XYZ end', 'abcdef XYZ end', 7)).toBe(10);
    expect(mapTextOffset('abc XYZ end', 'abc end', 5)).toBe(4);
    expect(mapTextOffset('中文🙂 draft', '前缀 中文🙂 draft', 6)).toBe(9);
  });
  it('leaves an unchanged offset alone', () => {
    expect(mapTextOffset('same', 'same', 3)).toBe(3);
  });
  it('rebases a selection between two separate image rewrites', () => {
    const markdown = '![](mdplus-image:one)\n\n选择这里\n\n![](mdplus-image:two)';
    const refs = [{ placeholder: 'mdplus-image:one', relativePath: './assets/图片 一.png' },
      { placeholder: 'mdplus-image:two', relativePath: './assets/b.png' }];
    const result = rewriteImageReferences(markdown, refs);
    expect(mapImageOffset(markdown, refs, markdown.indexOf('选择'))).toBe(result.indexOf('选择'));
    expect(mapImageOffset(markdown, refs, markdown.length)).toBe(result.length);
  });
  it('handles repeated image URLs and definitions shared with links', () => {
    const markdown = '![a][img] select ![b][img] [download][img]\n\n[img]: old.png "title"';
    const refs = [{ placeholder: 'old.png', relativePath: './new/long image.png' }];
    const result = rewriteImageReferences(markdown, refs);
    expect(mapImageOffset(markdown, refs, markdown.indexOf('select'))).toBe(result.indexOf('select'));
    expect(mapImageOffset(markdown, refs, markdown.indexOf('[download]'))).toBe(result.indexOf('[download]'));
  });
});
