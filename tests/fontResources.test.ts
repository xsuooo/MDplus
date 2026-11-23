// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blobDataURL, dataURL } from '../src/lib/fontResources';

const woff2 = 'wOF2OTTO-native-font-bytes';
const encoded = btoa(woff2);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('portable resource media types', () => {
  it.each(['text/html', 'application/octet-stream', 'application/font-woff'])(
    'uses the WOFF2 byte signature instead of the native %s label',
    async (type) => {
      const fetchResource = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: async () => new Blob([woff2], { type }),
      });
      vi.stubGlobal('fetch', fetchResource);

      expect(await dataURL('/assets/MiSans-Regular.woff2')).toBe(
        'data:font/woff2;base64,' + encoded,
      );
      expect(fetchResource).toHaveBeenCalledOnce();
    },
  );

  it('normalizes an already inline WOFF2 resource without fetching', async () => {
    const fetchResource = vi.fn();
    vi.stubGlobal('fetch', fetchResource);
    expect(await dataURL('data:text/html;base64,' + encoded)).toBe(
      'data:font/woff2;base64,' + encoded,
    );
    expect(fetchResource).not.toHaveBeenCalled();
  });

  it('preserves the complete correctly labelled font bytes', async () => {
    expect(await blobDataURL(new Blob([woff2], { type: 'font/woff2' }))).toBe(
      'data:font/woff2;base64,' + encoded,
    );
  });

  it.each([
    ['image/png', '\x89PNG-image-bytes'],
    ['application/pdf', '%PDF-1.3-license'],
    ['text/plain', 'full-font-license'],
  ])('leaves non-font %s bytes and media type unchanged', async (type, bytes) => {
    const blob = new Blob([bytes], { type });
    const expected = Buffer.from(bytes, 'utf8').toString('base64');
    expect(await blobDataURL(blob)).toBe('data:' + type + ';base64,' + expected);
  });

  it.each(['data:image/svg+xml,%3Csvg%2F%3E', 'data:image/png;base64,%'])(
    'does not reinterpret unrelated inline resources: %s',
    async (value) => {
      expect(await dataURL(value)).toBe(value);
    },
  );

  it('still rejects a failed resource response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(dataURL('/assets/missing.woff2')).rejects.toThrow('资源读取失败 (404)');
  });
});
