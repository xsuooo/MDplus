import { afterEach, expect, it, vi } from 'vitest';
import { buildId } from '../config/build';

afterEach(() => vi.unstubAllEnvs());
it('accepts an immutable build identifier supplied by CI', () => {
  vi.stubEnv('MDPLUS_BUILD_ID', 'release-0.2.5+abc123');
  expect(buildId()).toBe('release-0.2.5+abc123');
});
it('rejects malformed build labels instead of embedding them into a bundle', () => {
  vi.stubEnv('MDPLUS_BUILD_ID', 'unexpected\nlabel');
  expect(() => buildId()).toThrow('Invalid build identifier');
});
