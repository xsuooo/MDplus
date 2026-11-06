import { describe, expect, it } from 'vitest';
import capability from '../src-tauri/capabilities/default.json';
import tauri from '../src-tauri/tauri.conf.json';

describe('main-window recovery capability', () => {
  it('allows only fixed-path atomic settings commands and no plugin Store writes', () => {
    expect(capability.permissions).toContain('allow-load-settings');
    expect(capability.permissions).toContain('allow-save-settings');
    expect(capability.permissions.some((name) => name.startsWith('store:'))).toBe(false);
  });
  it('limits session image preview sources to images without expanding scripts or connections', () => {
    const directives = Object.fromEntries(
      tauri.app.security.csp.split(';').map((entry) => {
        const [name, ...sources] = entry.trim().split(/\s+/);
        return [name, sources];
      }),
    );
    expect(directives['img-src']).toContain('mdplus-image-stash:');
    expect(directives['img-src']).toContain('http://mdplus-image-stash.localhost');
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['connect-src']).toEqual(["'self'", 'ipc:', 'http://ipc.localhost']);
    expect(directives['img-src']).not.toContain('*');
  });

  it('grants the window operations used during startup and state restoration', () => {
    expect(capability.windows).toEqual(['main']);
    // 恢复窗口位置前需要读取显示器工作区
    expect(capability.permissions).toContain('core:window:allow-available-monitors');
    for (const operation of ['set-size', 'set-position', 'show', 'set-focus', 'unminimize']) {
      expect(capability.permissions).toContain(`core:window:allow-${operation}`);
    }
  });
});
