import { describe, expect, it } from 'vitest';
import { mergeSessionDocuments, sanitizeDocumentSession } from '../src/lib/documentSession';
import { resolveTextAnchor, sanitizeSessionPlace, textAnchor } from '../src/lib/sessionPosition';

describe('session text anchors', () => {
  it('finds source positions after a prefix was inserted on disk', () => {
    const before = '# 文稿\n\n第一段落。\n\n保留选择的目标文字🙂。\n\n最后一段。\n';
    const start = textAnchor(before, before.indexOf('目标文字'));
    const end = textAnchor(before, before.indexOf('目标文字') + '目标文字🙂'.length);
    const after = '磁盘中新插入的一段正文。\n\n' + before;
    expect(after.slice(resolveTextAnchor(after, start), resolveTextAnchor(after, end))).toBe(
      '目标文字🙂',
    );
  });

  it('keeps duplicate contexts attached to the nearest old occurrence', () => {
    const paragraph = 'Same paragraph contents. '.repeat(5) + '\n';
    const markdown = paragraph.repeat(20);
    const offset = paragraph.length * 12 + 50;
    const anchor = textAnchor(markdown, offset);
    const latest = '# New title\n\n' + markdown;
    expect(resolveTextAnchor(latest, anchor)).toBe(offset + '# New title\n\n'.length);
  });

  it('uses line/column or a clamped offset when all context was removed', () => {
    const anchor = textAnchor('one\nold target line\nlast', 10);
    expect(resolveTextAnchor('one\nreplacement\nlast', anchor)).toBe(10);
    expect(resolveTextAnchor('tiny', anchor)).toBe(4);
  });

  it('bounds contexts and rejects invalid persisted numeric positions', () => {
    const anchor = textAnchor('x'.repeat(1000), 500);
    expect(anchor.before).toHaveLength(40);
    expect(anchor.after).toHaveLength(40);
    const valid = {
      sourceMode: true,
      start: anchor,
      end: anchor,
      direction: 'backward',
      top: 123,
      left: 0,
    };
    expect(sanitizeSessionPlace(valid)?.direction).toBe('backward');
    for (const top of [Infinity, NaN, -1, '123'])
      expect(sanitizeSessionPlace({ ...valid, top })).toBeUndefined();
    expect(
      sanitizeSessionPlace({ ...valid, start: { ...anchor, after: 'x'.repeat(41) } }),
    ).toBeUndefined();
  });
});

describe('saved document session boundaries', () => {
  it('keeps order, deduplicates path aliases, and drops unsaved, body and runtime fields', () => {
    const source = {
      version: 1,
      activePath: 'c:/NOTES/a.md',
      markdown: 'stale whole draft',
      documents: [
        {
          path: 'C:/notes/a.md',
          title: 'a.md',
          id: 'recovery-id',
          markdown: 'stale body',
          doc: { runtime: true },
        },
        { path: '\\\\?\\C:\\notes\\.\\a.md', title: 'alias.md' },
        { path: 'C:/notes/b.md', title: 'b.md' },
        { path: null, title: 'new.md', markdown: 'unsaved draft' },
        { path: 'relative.md', title: 'relative.md' },
        { path: 'C:/bad\u0000.md', title: 'invalid.md' },
      ],
    };
    expect(sanitizeDocumentSession(source)).toEqual({
      version: 1,
      documents: [
        { path: 'C:/notes/a.md', title: 'a.md' },
        { path: 'C:/notes/b.md', title: 'b.md' },
      ],
      activePath: 'C:/notes/a.md',
    });
    expect(JSON.stringify(sanitizeDocumentSession(source))).not.toMatch(
      /stale|recovery-id|runtime|unsaved/,
    );
  });

  it('retains failed paths in their prior slots while omitting explicitly closed paths', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((name) => ({
      path: `C:/${name}.md`,
      title: `${name}.md`,
    }));
    expect(mergeSessionDocuments([b, d], [a, c], [a, b, c])).toEqual([a, b, c, d]);
    expect(mergeSessionDocuments([d], [a], [a, b, c])).toEqual([a, d]);
    expect(mergeSessionDocuments([a, b], [a], [a, b])).toEqual([a, b]);
  });

  it('falls back to an empty session for unknown versions and damaged lists', () => {
    for (const value of [null, [], { version: 2, documents: [] }, { version: 1, documents: null }])
      expect(sanitizeDocumentSession(value)).toEqual({
        version: 1,
        documents: [],
        activePath: null,
      });
  });
});
