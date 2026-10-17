import { describe, expect, it } from 'vitest';
import capability from '../src-tauri/capabilities/default.json';

describe('main-window recovery capability', () => {
  it('grants the window operations used during startup and state restoration', () => {
    expect(capability.windows).toEqual(['main']);
    // 恢复窗口位置前需要读取显示器工作区
    expect(capability.permissions).toContain('core:window:allow-available-monitors');
    for (const operation of ['set-size', 'set-position', 'show', 'set-focus', 'unminimize']) {
      expect(capability.permissions).toContain(`core:window:allow-${operation}`);
    }
  });
});
