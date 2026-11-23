import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ast } from '../src/lib/position/editorPosition';

let transport: {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
};
beforeEach(async () => {
  transport = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', transport);
  vi.resetModules();
  await import('../src/lib/sourceOutline.worker');
});
afterEach(() => vi.unstubAllGlobals());

function parse(markdown: string): Ast {
  transport.onmessage!({ data: markdown } as MessageEvent<string>);
  expect(transport.postMessage).toHaveBeenCalledTimes(1);
  return transport.postMessage.mock.calls[0][0] as Ast;
}

describe('actual source outline worker math grammar', () => {
  it('extracts real headings and definitions around math, not fake ones inside a block', () => {
    const source =
      '# Before $x^2$\n\n[before]: /before\n\n$$\n# Not a heading\n[hidden]: /hidden\n\\frac{1}{2}\n$$\n\n## After\n\n[after]: /after\n';
    const ast = parse(source);
    expect(ast.type).toBe('root');
    expect(ast.children!.map((node) => node.type)).toEqual([
      'heading',
      'definition',
      'heading',
      'definition',
    ]);
    expect(ast.children![0].children!.map((node) => [node.type, node.value])).toEqual([
      ['text', 'Before '],
      ['inlineMath', 'x^2'],
    ]);
    expect(ast.children![2].children![0].value).toBe('After');
    expect(ast.children!.map((node) => node.position!.start.offset)).toEqual([
      source.indexOf('# Before'),
      source.indexOf('[before]'),
      source.indexOf('## After'),
      source.indexOf('[after]'),
    ]);
  });

  it('leaves malformed LaTeX harmless to heading and definition extraction', () => {
    const source =
      '# Inline $\\unknown{bad$\n\n$$\n\\frac{\n# Still inside math\n[hidden]: /hidden\n$$\n\n# Last\n\n[visible]: /visible';
    const ast = parse(source);
    expect(ast.children!.map((node) => node.type)).toEqual(['heading', 'heading', 'definition']);
    expect(ast.children![0].children![1]).toMatchObject({
      type: 'inlineMath',
      value: String.raw`\unknown{bad`,
    });
    expect(ast.children![1].children![0].value).toBe('Last');
    expect(ast.children![2].position!.start.offset).toBe(source.indexOf('[visible]'));
  });

  it('does not invent headings after an unterminated math fence', () => {
    const ast = parse('# Before\n\n$$\n\\unknown{\n# swallowed\n[hidden]: /hidden');
    expect(ast.children).toHaveLength(1);
    expect(ast.children![0].children![0].value).toBe('Before');
  });
});
