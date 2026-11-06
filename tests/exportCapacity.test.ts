// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { Blob as NativeBlob } from 'node:buffer';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../src/config/constants';
import { DEFAULT_BODY_FONT, DEFAULT_CODE_FONT } from '../src/lib/editorFont';
import { assertExportBytes, exportByteLength, exportHTML } from '../src/lib/export';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), save: vi.fn(), write: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
vi.mock('../src/lib/dialog', () => ({ confirmDialog: mocks.confirm }));
vi.mock('../src/lib/fileOps', () => ({ exportHtmlFile: mocks.write }));

const root = process.cwd();
beforeEach(() => {
  vi.resetAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.save.mockResolvedValue('D:/virtual-export/result.html');
  mocks.write.mockImplementation(async (_path: string, html: string) => {
    assertExportBytes(exportByteLength(html));
  });
  // Use actual bundled fonts/licenses, with only the resource transport replaced.
  // No HTTP requests or writes to the selected virtual output path are made.
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(value, document.baseURI);
    const pathname = decodeURIComponent(url.pathname);
    let file: string;
    if (pathname.startsWith('/src/assets/fonts/')) file = path.join(root, pathname.slice(1));
    else if (pathname.startsWith('/font-licenses/'))
      file = path.join(root, 'public', pathname.slice(1));
    else throw new Error(`Unexpected resource in export test: ${url.pathname}`);
    const bytes = await readFile(file);
    const type = file.endsWith('.pdf')
      ? 'application/pdf'
      : file.endsWith('.woff2')
        ? 'font/woff2'
        : 'text/plain';
    return {
      ok: true,
      status: 200,
      blob: async () => new NativeBlob([bytes], { type }),
      text: async () => bytes.toString('utf8'),
    };
  });
  vi.stubGlobal(
    'FileReader',
    class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then(
          (bytes) => {
            this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
            this.onload?.();
          },
          () => this.onerror?.(),
        );
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('portable export size contract', () => {
  it('exports a minimal document with the actual default fonts above the Markdown limit', async () => {
    const content = document.createElement('div');
    content.className = 'ProseMirror';
    content.textContent = 'hello';
    await expect(
      exportHTML({
        title: 'default-font-regression',
        content,
        bodyFont: DEFAULT_BODY_FONT,
        codeFont: DEFAULT_CODE_FONT,
      }),
    ).resolves.toBe(true);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const html = mocks.write.mock.calls[0][1] as string;
    expect(exportByteLength(html)).toBeGreaterThan(LIMITS.textFileBytes);
    expect(exportByteLength(html)).toBeLessThan(LIMITS.htmlExportBytes);
    expect(html.match(/@font-face/g)).toHaveLength(5);
    expect(html).toContain('MiSans-License.pdf');
    expect(html).toContain('SIL OPEN FONT LICENSE');
    expect(html).not.toContain('mdplus-image-stash');
  }, 30000);

  it('uses the independent export limit including its exact boundary', () => {
    expect(() => assertExportBytes(LIMITS.textFileBytes + 1)).not.toThrow();
    expect(() => assertExportBytes(LIMITS.htmlExportBytes)).not.toThrow();
    expect(() => assertExportBytes(LIMITS.htmlExportBytes + 1)).toThrow('上限');
    expect(() => assertExportBytes(Number.NaN)).toThrow();
  });

  it.each(['', 'ascii', '中文', 'emoji 😀', '\ud800', '\udc00', 'A\u0000B'])(
    'counts UTF-8 accurately without a full encoded copy: %j',
    (text) => {
      expect(exportByteLength(text)).toBe(new TextEncoder().encode(text).length);
    },
  );
});
