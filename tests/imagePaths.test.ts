import { describe, expect, it } from 'vitest';
import { rewriteImageReferences } from '../src/lib/imagePaths';

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
