import { describe, expect, it } from 'vitest';
import { computeStats } from '../src/lib/stats';

describe('computeStats', () => {
  it('counts an empty document as one line', () => {
    expect(computeStats('')).toEqual({ chars: 0, words: 0, lines: 1 });
  });

  it('excludes whitespace from the character count', () => {
    expect(computeStats('hello world').chars).toBe(10);
  });

  it('counts english words, not letters', () => {
    expect(computeStats('hello world').words).toBe(2);
  });

  it('counts chinese per character', () => {
    expect(computeStats('你好世界')).toEqual({ chars: 4, words: 4, lines: 1 });
  });

  it('adds chinese characters and english words together', () => {
    expect(computeStats('你好 hello')).toEqual({ chars: 7, words: 3, lines: 1 });
  });

  it('counts lines by newline', () => {
    expect(computeStats('a\nb\nc').lines).toBe(3);
  });
});
