import { describe, expect, it } from 'vitest';
import { version } from '../package.json';
import { BUILD_LABEL } from '../src/lib/buildInfo';
import { APP_VERSION, APP_VERSION_DETAILS, APP_VERSION_LABEL } from '../src/lib/appVersion';

describe('application version metadata', () => {
  it('uses the owning package version for the visible release label', () => {
    expect(APP_VERSION).toBe(version);
    expect(APP_VERSION_LABEL).toBe(`v${version}`);
  });

  it('retains the build identity already injected into this bundle', () => {
    expect(APP_VERSION_DETAILS).toContain(BUILD_LABEL);
    expect(APP_VERSION_DETAILS).toContain(__MDPLUS_BUILD_ID__);
  });
});
