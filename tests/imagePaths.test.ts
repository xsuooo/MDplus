import { describe, expect, it } from 'vitest';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { getImageUrls, rewriteImageReferences } from '../src/lib/imagePaths';

function renderGfm(markdown: string) {
  return micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
}

describe('rewriteImageReferences', () => {
  it('replaces every occurrence of a pending image placeholder', () => {
    const placeholder = 'data:image/png;base64,abc123';
    const markdown = `before ![](${placeholder})\nafter ![](${placeholder})`;

    expect(
      rewriteImageReferences(markdown, [
        { placeholder, relativePath: './assets/image.png' },
      ]),
    ).toBe('before ![](./assets/image.png)\nafter ![](./assets/image.png)');
  });

  it('rewrites an angle-wrapped image destination without touching its title, links or code', () => {
    const markdown = [
      '![photo](<./img/my pic.png> "caption") [download](<./img/my pic.png>)',
      '`![example](<./img/my pic.png> "caption")`',
      '```md',
      '![example](<./img/my pic.png> "caption")',
      '```',
    ].join('\n');

    expect(rewriteImageReferences(markdown, [
      { placeholder: './img/my pic.png', relativePath: './assets/my pic.png' },
    ])).toBe([
      '![photo](<./assets/my pic.png> "caption") [download](<./img/my pic.png>)',
      '`![example](<./img/my pic.png> "caption")`',
      '```md',
      '![example](<./img/my pic.png> "caption")',
      '```',
    ].join('\n'));
  });

  it('rewrites only definitions used by full, collapsed and shortcut images', () => {
    const markdown = [
      '![one][Photo] ![photo][] ![photo]',
      '[ordinary][unused]',
      '',
      '[PHOTO]: <./img/my pic.png> \'caption\'',
      '[photo]: ignored.png',
      '[unused]: ./img/my pic.png',
    ].join('\n');

    expect(rewriteImageReferences(markdown, [
      { placeholder: './img/my pic.png', relativePath: './assets/my pic.png' },
    ])).toBe([
      '![one][Photo] ![photo][] ![photo]',
      '[ordinary][unused]',
      '',
      '[PHOTO]: <./assets/my pic.png> \'caption\'',
      '[photo]: ignored.png',
      '[unused]: ./img/my pic.png',
    ].join('\n'));
  });

  it('does not redirect normal links sharing a definition with migrated images', () => {
    const markdown = [
      '![photo][shared] [download][shared] ![shared][] ![shared]',
      '',
      '[shared]: ./img/pic.png "caption"',
    ].join('\n');

    expect(rewriteImageReferences(markdown, [
      { placeholder: './img/pic.png', relativePath: './assets/pic.png' },
    ])).toBe([
      '![photo](./assets/pic.png "caption") [download][shared] ![shared](./assets/pic.png "caption") ![shared](./assets/pic.png "caption")',
      '',
      '[shared]: ./img/pic.png "caption"',
    ].join('\n'));
  });

  it.each([
    ['![alt](./img/pic.png "caption")', '![alt](./assets/pic.png "caption")'],
    ["![alt](./img/pic.png 'caption')", "![alt](./assets/pic.png 'caption')"],
    ['![alt](./img/pic.png (caption))', '![alt](./assets/pic.png (caption))'],
    ['![alt](\n  ./img/pic.png\n  "caption"\n)', '![alt](\n  ./assets/pic.png\n  "caption"\n)'],
    ['![alt with [brackets] and \\] escape](./img/pic.png)', '![alt with [brackets] and \\] escape](./assets/pic.png)'],
    ['[![alt](./img/pic.png)](./img/pic.png)', '[![alt](./assets/pic.png)](./img/pic.png)'],
  ])('preserves surrounding syntax when rewriting %s', (markdown, expected) => {
    expect(rewriteImageReferences(markdown, [
      { placeholder: './img/pic.png', relativePath: './assets/pic.png' },
    ])).toBe(expected);
  });

  it('decodes escaped and nested parentheses without truncating destinations', () => {
    const markdown = String.raw`![escaped](./img/a\(b\).png "title (one)") ![nested](./img/a(b(c)).png)`;
    expect(rewriteImageReferences(markdown, [
      { placeholder: './img/a(b).png', relativePath: './assets/first.png' },
      { placeholder: './img/a(b(c)).png', relativePath: './assets/second.png' },
    ])).toBe('![escaped](./assets/first.png "title (one)") ![nested](./assets/second.png)');
  });

  it('encodes replacement destinations so spaces, parentheses and entities survive reparsing', () => {
    const replacement = './assets/a(b) &copy;.png';
    const rewritten = rewriteImageReferences('![alt](old.png "caption")', [
      { placeholder: 'old.png', relativePath: replacement },
    ]);
    expect(rewritten).toBe('![alt](<./assets/a(b) &amp;copy;.png> "caption")');
    expect(rewriteImageReferences(rewritten, [
      { placeholder: replacement, relativePath: 'restored.png' },
    ])).toBe('![alt](<restored.png> "caption")');
  });

  it('preserves CRLF and Unicode offsets and ignores images in HTML and escaped examples', () => {
    const markdown = [
      '😀 ![图](pic.png "标题")',
      '',
      '\\![example](pic.png)',
      '',
      '<pre>',
      '![example](pic.png)',
      '</pre>',
      '',
      '<!-- ![example](pic.png) -->',
    ].join('\r\n');
    expect(rewriteImageReferences(markdown, [
      { placeholder: 'pic.png', relativePath: 'new.png' },
    ])).toBe(markdown.replace('![图](pic.png "标题")', '![图](new.png "标题")'));
  });

  it('preserves image alt text that contains a nested image or a link', () => {
    const markdown = '![outer ![inner](inner.png) [label](link.png)](outer.png)';
    expect(rewriteImageReferences(markdown, [
      { placeholder: 'inner.png', relativePath: 'changed-inner.png' },
      { placeholder: 'link.png', relativePath: 'changed-link.png' },
      { placeholder: 'outer.png', relativePath: 'changed-outer.png' },
    ])).toBe('![outer ![inner](inner.png) [label](link.png)](changed-outer.png)');
  });

  it('keeps the decoded title when splitting a shared reference', () => {
    const markdown = '![photo][shared] [download][shared]\n\n[shared]: pic.png \'say "yes" &amp; go\'';
    expect(rewriteImageReferences(markdown, [
      { placeholder: 'pic.png', relativePath: 'new.png' },
    ])).toBe('![photo](new.png "say \\"yes\\" &amp; go") [download][shared]\n\n[shared]: pic.png \'say "yes" &amp; go\'');
  });

  it.each([
    ['line feeds', 'one&#10;&#10;two'],
    ['carriage returns', 'one&#13;&#13;two'],
    ['mixed line endings', 'one&#13;&#10;&#13;&#10;two'],
  ])('keeps shared titles with %s parseable after expansion', (_name, title) => {
    const markdown = `![photo][shared] [download][shared]\n\n[shared]: pic.png "${title}"`;
    const rewritten = rewriteImageReferences(markdown, [
      { placeholder: 'pic.png', relativePath: 'new.png' },
    ]);
    expect(getImageUrls(rewritten)).toEqual(['new.png']);
    expect(renderGfm(rewritten)).toBe(renderGfm(markdown).replace('src="pic.png"', 'src="new.png"'));
  });

  it('keeps table cells intact when a shared title contains an encoded pipe', () => {
    const markdown = '| image | download |\n| - | - |\n| ![photo][shared] | [download][shared] |\n\n[shared]: pic.png "left &#124; right"';
    const rewritten = rewriteImageReferences(markdown, [
      { placeholder: 'pic.png', relativePath: 'new.png' },
    ]);
    expect(renderGfm(rewritten)).toBe(renderGfm(markdown).replace('src="pic.png"', 'src="new.png"'));
  });

  it('finds and rewrites GFM images between code markers in separate table cells', () => {
    const markdown = '| a | b | c |\n| - | - | - |\n| ` | ![photo](pic.png) | ` |';
    expect(getImageUrls(markdown)).toEqual(['pic.png']);
    const rewritten = rewriteImageReferences(markdown, [
      { placeholder: 'pic.png', relativePath: 'new.png' },
    ]);
    expect(rewritten).toBe(markdown.replace('pic.png', 'new.png'));
    expect(renderGfm(rewritten)).toBe(renderGfm(markdown).replace('src="pic.png"', 'src="new.png"'));
  });

  it.each([
    '$![photo](pic.png)$',
    '$$\n![photo](pic.png)\n$$',
    '$![photo][ref]$\n\n[ref]: pic.png',
  ])('ignores image-like syntax in editor math: %s', (markdown) => {
    expect(getImageUrls(markdown)).toEqual([]);
    expect(rewriteImageReferences(markdown, [
      { placeholder: 'pic.png', relativePath: 'new.png' },
    ])).toBe(markdown);
  });

  it('leaves unrelated image references untouched', () => {
    expect(
      rewriteImageReferences('![](./assets/old.png)', [
        { placeholder: 'data:image/png;base64,new', relativePath: './assets/new.png' },
      ]),
    ).toBe('![](./assets/old.png)');
  });

  it('only rewrites image destinations, not prose or normal links', () => {
    expect(rewriteImageReferences(
      'pic.png [download](pic.png) ![](pic.png)',
      [{ placeholder: 'pic.png', relativePath: './assets/pic.png' }],
    )).toBe('pic.png [download](pic.png) ![](./assets/pic.png)');
  });
});
