import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bench, describe, expect, vi } from 'vitest';
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Transform } from '@milkdown/prose/transform';
import { createEditor } from '../../src/lib/editor';
import { computeStats } from '../../src/lib/stats';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: native.invoke,
}));

// These measure frontend regressions in jsdom, not native IPC, layout, or input latency.
const MEASURED_ITERATIONS = 50;
const WARMUP_ITERATIONS = 10;
const HISTORY_VERSIONS = 20;
const fixedIterations = {
  time: 0,
  iterations: MEASURED_ITERATIONS,
  warmupTime: 0,
  warmupIterations: WARMUP_ITERATIONS,
};
const fixtureNames = ['table-1200', 'long-5000', 'images-20'] as const;
const imageBytes = Buffer.from('MDPlus synthetic native image fixture').toString('base64');

for (const name of fixtureNames) {
  const markdown = readFileSync(path.resolve('tests/perf/fixtures', `${name}.md`), 'utf8');
  expect(markdown.length, `${name} must not be empty`).toBeGreaterThan(0);

  describe(`${name} / frontend regression only`, () => {
    let serialize: (doc: PMNode) => string;
    let edited: PMNode;
    let serialized = '';
    bench(
      'serializerCtx / one edited textblock',
      () => {
        serialized = serialize(edited);
      },
      {
        ...fixedIterations,
        async setup(task) {
          const host = document.createElement('div');
          document.body.append(host);
          const editor = createEditor(host, markdown, { onUpdate: () => {} });
          try {
            await editor.create();
            const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
            serialize = editor.action((ctx) => ctx.get(serializerCtx));
            doc.check();
            const positions: number[] = [];
            doc.descendants((node, pos) => {
              if (node.isText) positions.push(pos);
            });
            expect(positions.length).toBeGreaterThan(0);
            const position = positions[Math.floor(positions.length / 2)];
            const change = () => new Transform(doc).insert(position, doc.type.schema.text('x')).doc;
            const baseline = serialize(doc);
            const changed = change();
            changed.check();
            const expected = serialize(changed);
            expect(expected).not.toBe(baseline);
            expect(editor.action((ctx) => ctx.get(parserCtx)(expected))?.textContent).toBe(
              changed.textContent,
            );
            serialized = '';
            // Each sample changes a fresh node; unchanged blocks retain their production caches.
            task.opts.beforeEach = () => {
              edited = change();
            };
            task.opts.afterAll = async () => {
              try {
                expect(serialized).toBe(expected);
                expect(serialize(doc)).toBe(baseline);
              } finally {
                await editor.destroy();
                host.remove();
              }
            };
          } catch (error) {
            await editor.destroy();
            host.remove();
            throw error;
          }
        },
      },
    );

    let stats: ReturnType<typeof computeStats> | undefined;
    bench(
      'computeStats / complete source',
      () => {
        stats = computeStats(markdown);
      },
      {
        ...fixedIterations,
        setup(task) {
          const expected = {
            chars: markdown.replace(/\s/g, '').length,
            words: (markdown.match(/[\u4e00-\u9fa5]|[A-Za-z]+/g) ?? []).length,
            lines: markdown.split('\n').length,
          };
          stats = undefined;
          task.opts.afterAll = () => {
            expect(stats).toEqual(expected);
          };
        },
      },
    );

    let collect: () => Promise<void>;
    bench(
      'collectUnusedImages / current source + 20 history versions',
      async () => {
        await collect();
      },
      {
        ...fixedIterations,
        async setup(task, mode) {
          // Both private image caches are fresh for every fixture and warmup/measured phase.
          vi.resetModules();
          vi.stubGlobal('crypto', webcrypto);
          const stashes = new Map<string, string>();
          let nextStash = 0;
          native.invoke.mockReset();
          native.invoke.mockImplementation(
            async (command: string, args: Record<string, unknown>) => {
              if (command === 'read_image_file') {
                expect(typeof args.docPath).toBe('string');
                expect(typeof args.relativePath).toBe('string');
                return {
                  path: path.win32.resolve(
                    path.win32.dirname(args.docPath as string),
                    args.relativePath as string,
                  ),
                  mime: 'image/png',
                  dataBase64: imageBytes,
                };
              }
              if (command === 'stash_image') {
                expect(args.dataBase64).toBe(imageBytes);
                const key = `perf-stash-${++nextStash}`;
                stashes.set(key, imageBytes);
                return {
                  key,
                  mime: 'image/png',
                  previewUrl: `data:image/png;base64,${imageBytes}`,
                };
              }
              if (command === 'discard_stashed_images') {
                expect(Array.isArray(args.keys)).toBe(true);
                for (const key of args.keys as string[]) stashes.delete(key);
                return;
              }
              throw new Error(`Unexpected benchmark native command: ${command}`);
            },
          );
          const images = await import('../../src/lib/imageOps');
          const { getImageUrls } = await import('../../src/lib/imagePaths');
          const id = `perf-${name}`;
          const versions = Array.from(
            { length: HISTORY_VERSIONS },
            (_, index) => `${markdown}\n\nHistory revision ${String(index).padStart(2, '0')}.\n`,
          );
          expect(new Set(versions).size).toBe(HISTORY_VERSIONS);
          const sources = [markdown, ...versions];
          let rootCalls = 0;
          let visitedSources = 0;
          let unregister = () => {};
          try {
            const prepared = await images.prepareImageReferences(
              id,
              markdown,
              `C:\\perf\\${name}.md`,
            );
            expect(prepared.commit()).toBe(true);
            const imageCount = name === 'images-20' ? 20 : 0;
            expect(images.getPendingImages(id)).toHaveLength(imageCount);
            expect(stashes.size).toBe(imageCount);
            // Match SourceEditor's current/undo/redo traversal with real registration and parsing.
            unregister = images.registerImageReachability(id, () => {
              rootCalls++;
              const urls = new Set<string>();
              for (const source of sources) {
                visitedSources++;
                for (const url of getImageUrls(source)) urls.add(url);
              }
              return urls;
            });
            collect = () => images.collectUnusedImages(id);
            await collect();
            expect(rootCalls).toBe(imageCount ? 1 : 0);
            expect(visitedSources).toBe(imageCount ? HISTORY_VERSIONS + 1 : 0);
            expect(images.getPendingImages(id)).toHaveLength(imageCount);
            rootCalls = 0;
            visitedSources = 0;
            native.invoke.mockClear();
            task.opts.afterAll = async () => {
              try {
                const iterations = mode === 'run' ? MEASURED_ITERATIONS : WARMUP_ITERATIONS;
                expect(rootCalls).toBe(iterations);
                expect(visitedSources).toBe(iterations * (HISTORY_VERSIONS + 1));
                expect(images.getPendingImages(id)).toHaveLength(imageCount);
                expect(native.invoke).not.toHaveBeenCalled();
              } finally {
                unregister();
                images.clearPendingImages(id);
                await Promise.resolve();
                vi.unstubAllGlobals();
              }
              expect(stashes.size).toBe(0);
            };
          } catch (error) {
            unregister();
            images.clearPendingImages(id);
            await Promise.resolve();
            vi.unstubAllGlobals();
            throw error;
          }
        },
      },
    );
  });
}
