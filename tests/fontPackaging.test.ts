import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { build } from 'vite';
import { expect, it } from 'vitest';

const fontFiles = [
  'MiSans-Regular.woff2',
  'MiSans-Semibold.woff2',
  'SarasaGothicSC-Regular.woff2',
  'SarasaGothicSC-SemiBold.woff2',
  'LXGWWenKai.woff2',
  'LXGWWenKai-Medium.woff2',
  'JetBrainsMono.woff2',
  'FiraCode.woff2',
  'CascadiaCode.ttf',
];

async function fontBundle(input: string | Record<string, string>) {
  const result = await build({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input,
        preserveEntrySignatures: 'strict',
        output: { manualChunks: () => undefined },
      },
    },
  });
  if (Array.isArray(result) || !('output' in result)) throw new Error('Expected one bundle');
  return result.output;
}

it('shares exactly the original nine font assets between display and offline export', async () => {
  const output = await fontBundle({
    fonts: fileURLToPath(new URL('../src/lib/fontResources.ts', import.meta.url)),
    styles: fileURLToPath(new URL('../src/styles/fonts.css', import.meta.url)),
  });
  const assets = output.filter((item) => item.type === 'asset');
  const fonts = assets.filter((asset) => /\.(woff2?|ttf|otf)$/.test(asset.fileName));
  expect(fonts).toHaveLength(fontFiles.length);
  const css = assets.find((asset) => asset.fileName.endsWith('.css'));
  expect(css).toBeDefined();
  const code = output
    .filter((item) => item.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n');
  for (const file of fontFiles) {
    const font = fonts.find((asset) => asset.names.includes(file));
    expect(font, `Missing ${file}`).toBeDefined();
    const original = await readFile(new URL(`../src/assets/fonts/${file}`, import.meta.url));
    expect(Buffer.from(font!.source).equals(original), `Changed ${file}`).toBe(true);
    expect(String(css!.source)).toContain(font!.fileName);
    expect(code).toContain(font!.fileName);
  }
  const descriptors = (source: string) => {
    const faces: Record<string, string>[] = [];
    postcss.parse(source).walkAtRules('font-face', (rule) => {
      const face: Record<string, string> = {};
      rule.walkDecls((declaration) => {
        if (declaration.prop !== 'src') face[declaration.prop] = declaration.value;
      });
      faces.push(face);
    });
    return faces;
  };
  expect(descriptors(String(css!.source))).toEqual(
    descriptors(await readFile(new URL('../src/styles/fonts.css', import.meta.url), 'utf8')),
  );
}, 30000);

it('does not bundle an unused font placed beside the supported font files', async () => {
  const temporary = await realpath(tmpdir());
  const fixture = await mkdtemp(join(temporary, 'mdplus-font-packaging-'));
  try {
    await Promise.all([
      mkdir(join(fixture, 'lib')),
      mkdir(join(fixture, 'assets/fonts'), { recursive: true }),
    ]);
    await Promise.all([
      ...['fontResources.ts', 'editorFont.ts'].map((file) =>
        copyFile(new URL(`../src/lib/${file}`, import.meta.url), join(fixture, 'lib', file)),
      ),
      ...[...fontFiles, 'unreferenced-backup.woff2'].map((file) =>
        writeFile(join(fixture, 'assets/fonts', file), `Synthetic packaging fixture: ${file}`),
      ),
    ]);
    const output = await fontBundle(join(fixture, 'lib/fontResources.ts'));
    const fonts = output
      .filter((asset) => asset.type === 'asset')
      .filter((asset) => /\.(woff2?|ttf|otf)$/.test(asset.fileName));
    expect(fonts.flatMap((asset) => asset.names).sort()).toEqual([...fontFiles].sort());
  } finally {
    const resolved = await realpath(fixture);
    expect(resolved.startsWith(`${temporary}${sep}`), 'Unsafe fixture cleanup').toBe(true);
    await rm(resolved, { recursive: true, force: true });
  }
}, 30000);
