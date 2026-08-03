import { describe, expect, it } from 'vitest';
import { BLANK_TEMPLATE, BASIC_TEMPLATE, getTemplate } from '../src/lib/templates';

describe('document templates', () => {
  it('returns the requested template', () => {
    expect(getTemplate('blank')).toBe(BLANK_TEMPLATE);
    expect(getTemplate('basic')).toBe(BASIC_TEMPLATE);
  });

  it('keeps the basic template useful as a smoke document', () => {
    expect(BASIC_TEMPLATE).toContain('```mermaid');
    expect(BASIC_TEMPLATE).toContain('$$');
    expect(BASIC_TEMPLATE).toContain('- [ ]');
  });
});
