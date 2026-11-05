import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function check(totals: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'mdplus-coverage-gate-'));
  roots.push(root);
  const report = join(root, 'report.json');
  writeFileSync(report, JSON.stringify({ data: [{ totals }] }));
  return execFileSync(process.execPath, ['scripts/check-rust-coverage.mjs', report], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
it('accepts a complete native report above the configured floor', () => {
  expect(check({ lines: { percent: 100 }, functions: { percent: 100 } })).toContain(
    'Rust lines: 100.00%',
  );
});
it.each([
  { lines: { percent: 0 }, functions: { percent: 100 } },
  { lines: { percent: 100 }, functions: { percent: 0 } },
  {},
])('fails the coverage gate for a low or missing production metric', (totals) => {
  expect(() => check(totals)).toThrow();
});
