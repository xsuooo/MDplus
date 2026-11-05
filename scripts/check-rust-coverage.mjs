import fs from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/check-rust-coverage.mjs <llvm-cov-report.json>');
const report = JSON.parse(fs.readFileSync(path, 'utf8'));
const thresholds = JSON.parse(
  fs.readFileSync(new URL('../config/coverage.json', import.meta.url), 'utf8'),
).rust;
const totals = report.data?.[0]?.totals;
for (const [metric, minimum] of Object.entries(thresholds)) {
  const actual = totals?.[metric]?.percent;
  if (!Number.isFinite(actual) || actual < minimum) {
    throw new Error(`Rust ${metric} coverage ${actual ?? 'missing'}% is below ${minimum}%`);
  }
  console.log(`Rust ${metric}: ${actual.toFixed(2)}% (minimum ${minimum}%)`);
}
