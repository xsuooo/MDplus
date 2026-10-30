import { describe, expect, it } from 'vitest';
import { fitMedia } from '../src/lib/media';

describe('media fit', () => {
  it('never enlarges small media', () => expect(fitMedia(80, 40, 800, 600)).toBe(1));
  it('fits wide and long media without cropping', () => {
    expect(fitMedia(1600, 400, 800, 600)).toBe(0.5);
    expect(fitMedia(200, 4000, 800, 600)).toBe(0.15);
  });
  it('does not propagate invalid geometry', () => {
    for (const value of [0, -1, Infinity, NaN]) expect(fitMedia(value, 100, 800, 600)).toBe(1);
  });
});
