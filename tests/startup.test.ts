import { describe, expect, it } from 'vitest';
import { startupView } from '../src/lib/startup';

describe('startup view', () => {
  it('keeps the welcome page hidden until startup file loading is resolved', () => {
    expect(startupView(false, 0)).toBe('loading');
  });

  it('shows the editor when a startup file has been opened', () => {
    expect(startupView(true, 1)).toBe('editor');
  });

  it('shows the welcome page after an empty startup is resolved', () => {
    expect(startupView(true, 0)).toBe('welcome');
  });
});
