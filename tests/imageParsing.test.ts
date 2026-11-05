import { beforeEach, describe, expect, it, vi } from 'vitest';

const parser = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('micromark', async (importOriginal) => {
  const original = await importOriginal<typeof import('micromark')>();
  parser.parse.mockImplementation(original.parse);
  return { ...original, parse: parser.parse };
});
import { getImageUrls, mapImageOffset, rewriteImageReferences } from '../src/lib/imagePaths';

beforeEach(() => parser.parse.mockClear());

describe('image parsing input cost and shared cache', () => {
  it('skips full parsing of a large image-free document', () => {
    const markdown = '# Heading\n\n普通段落 with **bold** and [link](https://example.com)\n'.repeat(
      20000,
    );
    expect(getImageUrls(markdown)).toEqual([]);
    expect(parser.parse).not.toHaveBeenCalled();
  });

  it('shares one parse across URL discovery, rewriting and selection mapping', () => {
    const markdown = '![cached][photo]\n\n[photo]: <./img/my photo.png> "caption"\n';
    const references = [{ placeholder: './img/my photo.png', relativePath: 'mdplus-image:cached' }];
    expect(getImageUrls(markdown)).toEqual(['./img/my photo.png']);
    expect(rewriteImageReferences(markdown, references)).toBe(
      '![cached][photo]\n\n[photo]: <mdplus-image:cached> "caption"\n',
    );
    expect(mapImageOffset(markdown, references, markdown.length)).toBe(
      rewriteImageReferences(markdown, references).length,
    );
    expect(parser.parse).toHaveBeenCalledOnce();
  });

  it('does not reuse an obsolete result after content changes', () => {
    const old = '![changing](./img/old.png)';
    const newer = '![changing](./img/new.png)';
    expect(getImageUrls(old)).toEqual(['./img/old.png']);
    expect(getImageUrls(newer)).toEqual(['./img/new.png']);
    expect(parser.parse).toHaveBeenCalledTimes(2);
  });

  it('evicts old documents instead of retaining an unbounded cache', () => {
    const documents = Array.from(
      { length: 5 },
      (_, index) => `![eviction-${index}](./img/${index}.png)`,
    );
    documents.forEach((markdown) => getImageUrls(markdown));
    expect(getImageUrls(documents[0])).toEqual(['./img/0.png']);
    expect(parser.parse).toHaveBeenCalledTimes(6);
  });
});
