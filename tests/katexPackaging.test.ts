import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { build } from 'vite';
import { expect, it } from 'vitest';

const katexDirectory = new URL('../node_modules/katex/dist/', import.meta.url);

function fontFaces(css: string) {
  const faces: Record<string, string>[] = [];
  postcss.parse(css).walkAtRules('font-face', (rule) => {
    const face: Record<string, string> = {};
    rule.walkDecls((declaration) => {
      face[declaration.prop] = declaration.value;
    });
    faces.push(face);
  });
  return faces;
}

it('ships every original KaTeX face as WOFF2 without duplicate legacy font assets', async () => {
  const original = await readFile(new URL('katex.min.css', katexDirectory), 'utf8');
  const result = await build({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: fileURLToPath(new URL('katex.min.css', katexDirectory)),
        output: { manualChunks: () => undefined },
      },
    },
  });
  if (Array.isArray(result) || !('output' in result)) throw new Error('Expected one bundle');
  const assets = result.output.filter((item) => item.type === 'asset');
  const css = assets.find((asset) => asset.fileName.endsWith('.css'));
  expect(css).toBeDefined();
  const sourceFaces = fontFaces(original);
  const outputFaces = fontFaces(String(css!.source));
  const descriptors = (faces: ReturnType<typeof fontFaces>) =>
    faces.map(({ src: _src, ...face }) => face);
  expect(sourceFaces).toHaveLength(20);
  expect(descriptors(outputFaces)).toEqual(descriptors(sourceFaces));
  for (let i = 0; i < sourceFaces.length; i++) {
    const name = sourceFaces[i].src.match(/fonts\/([^"')]+\.woff2)/)![1];
    const font = assets.find((asset) =>
      asset.fileName.startsWith(`assets/${name.replace('.woff2', '-')}`),
    );
    expect(font, `Missing ${name}`).toBeDefined();
    expect(Buffer.from(font!.source)).toEqual(
      await readFile(new URL(`fonts/${name}`, katexDirectory)),
    );
  }
  expect(assets.filter((asset) => /\.(woff|ttf)$/.test(asset.fileName))).toEqual([]);
  for (const face of outputFaces) {
    expect(face.src.match(/url\(/g)).toHaveLength(1);
    expect(face.src).toMatch(/\.woff2["']?\)\s*format\(["']woff2["']\)/);
  }
}, 30000);
