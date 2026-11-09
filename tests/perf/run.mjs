import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { fixtureNames, generateFixtures } from './generate.mjs';
import { browserMeasurements } from './browser-run.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = join(directory, '../..');
const repetitions = 3;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const evidence = join(directory, '.runs', runId);
const baselinePath = join(directory, 'report.baseline.json');
const reportPath = join(directory, 'report.json');
const nativeRustFlags = [
  process.env.CARGO_ENCODED_RUSTFLAGS ?? process.env.RUSTFLAGS?.trim().split(/\s+/).join('\x1f'),
  ...(process.platform === 'win32'
    ? [
        '-C',
        'link-arg=/MANIFEST:EMBED',
        '-C',
        "link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'",
      ]
    : []),
]
  .filter(Boolean)
  .join('\x1f');
const protocol = {
  repetitions,
  native: { profile: 'release', warmup: 5, samples: 30 },
  frontend: { runner: 'vitest bench', warmup: 10, samples: 50 },
  browser: {
    runner: 'agent-browser HeadlessChrome + CDP',
    server: 'Vite dev',
    warmupPerFixture: 1,
    inputSamples: 20,
  },
  quantiles: 'nearest rank over all measured calls from three repetitions; no best-run selection',
  gate: { minimumImprovement: 0.1, maximumRegression: 0.05, quantiles: ['p50', 'p95'] },
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const commandText = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();

function quantile(values, fraction) {
  assert(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
assert.equal(quantile([3, 1, 2], 0.5), 2);
assert.equal(quantile([3, 1, 2], 0.95), 3);

function metric(name, unit, samples) {
  assert.equal(samples.length, repetitions, `${name}: missing repetition`);
  const all = samples.flat();
  return {
    name,
    unit,
    samples,
    count: all.length,
    p50: quantile(all, 0.5),
    p95: quantile(all, 0.95),
    perRepetition: samples.map((values) => ({
      p50: quantile(values, 0.5),
      p95: quantile(values, 0.95),
    })),
  };
}

async function fingerprint(paths) {
  const files = await Promise.all(
    [...new Set(paths)].sort().map(async (path) => ({
      path,
      sha256: sha256(await readFile(join(root, path))),
    })),
  );
  return { sha256: sha256(JSON.stringify(files)), files };
}

async function run(command, args, label, environment = {}) {
  console.log(`[perf] ${label}`);
  const chunks = [];
  const errors = [];
  const child = spawn(command, args, {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', NO_COLOR: '1', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const stdout = Buffer.concat(chunks).toString();
  const stderr = Buffer.concat(errors).toString();
  await writeFile(join(evidence, `${label}.txt`), stdout + '\n' + stderr);
  if (code !== 0)
    throw new Error(
      `${label} failed (${code})\n${(stdout + '\n' + stderr).split('\n').slice(-30).join('\n')}`,
    );
  return stdout;
}

function marker(stdout, name) {
  const prefix = `${name}=`;
  const lines = stdout.split(/\r?\n/).filter((line) => line.includes(prefix));
  assert.equal(lines.length, 1, `Missing or repeated ${name}`);
  return JSON.parse(lines[0].slice(lines[0].indexOf(prefix) + prefix.length));
}
assert.deepEqual(marker('test native ... PERF_SAMPLE={"ok":true}\n', 'PERF_SAMPLE'), { ok: true });

function compare(baseline, current) {
  for (const key of ['commit', 'measurementSha256', 'fixturesSha256', 'environmentSha256']) {
    assert.equal(current[key], baseline[key], `Comparison identity changed: ${key}`);
  }
  const before = new Map(baseline.metrics.map((item) => [item.name, item]));
  assert.equal(before.size, current.metrics.length);
  const rows = current.metrics.map((after) => {
    const previous = before.get(after.name);
    assert(previous && previous.unit === after.unit, `Missing baseline: ${after.name}`);
    const changes = Object.fromEntries(
      protocol.gate.quantiles.map((key) => [
        key,
        previous[key] === 0
          ? after[key] === 0
            ? 0
            : null
          : (after[key] / previous[key] - 1) * 100,
      ]),
    );
    const regression = Object.values(changes).some(
      (value) => value === null || value > protocol.gate.maximumRegression * 100,
    );
    return {
      name: after.name,
      unit: after.unit,
      before: { p50: previous.p50, p95: previous.p95 },
      after: { p50: after.p50, p95: after.p95 },
      changePercent: changes,
      regression,
    };
  });
  const targets = rows.filter((row) => row.name.startsWith('rust/ipc_dispatch/'));
  assert.equal(targets.length, fixtureNames.length);
  const improved = targets.every((row) =>
    Object.values(row.changePercent).every(
      (value) => value !== null && value <= -protocol.gate.minimumImprovement * 100,
    ),
  );
  const regressions = rows.filter((row) => row.regression);
  return {
    status: improved && regressions.length === 0 ? 'retain-eligible' : 'reject',
    improved,
    regressions: regressions.map((row) => row.name),
    rows,
  };
}

await mkdir(evidence, { recursive: true });
let server;
try {
  const fixtures = await generateFixtures();
  const commit = commandText('git', ['--no-optional-locks', 'rev-parse', 'HEAD']);
  const productionFiles = commandText('git', [
    '--no-optional-locks',
    'ls-files',
    '-co',
    '--exclude-standard',
    '--',
    'src',
    'src-tauri',
    'config',
    'package.json',
    'package-lock.json',
    'vite.config.ts',
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  const source = await fingerprint(productionFiles);
  const measurement = await fingerprint([
    'tests/perf/run.mjs',
    'tests/perf/generate.mjs',
    'tests/perf/browser.ts',
    'tests/perf/browser-run.mjs',
    'tests/perf/index.html',
    'tests/perf/native.rs',
    'tests/perf/frontend.bench.ts',
    'tests/perf/vitest.config.ts',
    'tests/browser/nativeMocks.ts',
    'package-lock.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'vite.config.ts',
  ]);
  const environment = {
    machine: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    node: process.version,
    rustc: commandText('rustc', ['--version']),
    cargo: commandText('cargo', ['--version']),
    nativeRustFlags,
    releaseProfile: (await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8')).match(
      /\[profile.release\][\s\S]*?(?=\n\[)/,
    )?.[0],
  };
  const native = marker(
    await run(
      'cargo',
      [
        'test',
        '--release',
        '--locked',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--lib',
        'perf_native',
        '--',
        '--ignored',
        '--nocapture',
        '--test-threads=1',
      ],
      'native-release',
      { CARGO_ENCODED_RUSTFLAGS: nativeRustFlags },
    ),
    'MDPLUS_PERF_NATIVE',
  );
  const metrics = native.metrics.map((item) => metric(item.name, item.unit, item.samples));
  const frontend = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    frontend.push(
      marker(
        await run(
          process.execPath,
          [
            'node_modules/vitest/vitest.mjs',
            'bench',
            '--run',
            '--config',
            'tests/perf/vitest.config.ts',
            '--outputJson',
            join(evidence, `frontend-${repetition}.json`),
          ],
          `frontend-${repetition}`,
        ),
        'MDPLUS_PERF_FRONTEND',
      ),
    );
  }
  for (const first of frontend[0].metrics) {
    metrics.push(
      metric(
        first.name,
        first.unit,
        frontend.map((result) => {
          const found = result.metrics.find((item) => item.name === first.name);
          assert(found, `Missing frontend metric: ${first.name}`);
          assert.equal(found.samples.length, protocol.frontend.samples);
          return found.samples;
        }),
      ),
    );
  }
  server = await createServer({
    root,
    configFile: join(root, 'vite.config.ts'),
    cacheDir: join(directory, '.runs/vite-cache'),
    optimizeDeps: { entries: ['tests/perf/index.html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  console.log('[perf] browser');
  const browser = await browserMeasurements({
    url: `http://127.0.0.1:${address.port}/tests/perf/index.html`,
    evidence,
    fixtureNames,
    repetitions,
    root,
  });
  environment.browser = browser.browser;
  for (const name of fixtureNames) {
    const results = browser.samples.filter((sample) => sample.fixture === name);
    for (const [key, unit] of [
      ['inputToFrameMs', 'ms'],
      ['scrollFrameMs', 'ms'],
      ['initialOpenMs', 'ms'],
      ['editorCreateMs', 'ms'],
      ['longTaskCount', 'count'],
      ['domNodes', 'count'],
      ['retainedHeapBytes', 'bytes'],
    ])
      metrics.push(
        metric(
          `browser/${key}/${name}`,
          unit,
          results.map((result) => (Array.isArray(result[key]) ? result[key] : [result[key]])),
        ),
      );
    metrics.push(
      metric(
        `browser/longTaskTotalMs/${name}`,
        'ms',
        results.map((result) => [result.longTaskDurationMs.reduce((sum, value) => sum + value, 0)]),
      ),
    );
  }
  assert.equal(
    (await fingerprint(productionFiles)).sha256,
    source.sha256,
    'Source changed during measurement',
  );
  const current = {
    runId,
    commit,
    source,
    measurementSha256: measurement.sha256,
    fixturesSha256: sha256(JSON.stringify(fixtures)),
    environmentSha256: sha256(JSON.stringify(environment)),
    environment,
    protocol,
    fixtures,
    metrics,
    nativeScope: native.scope,
    frontendScope: frontend[0].scope,
    browser,
    evidenceDirectory: evidence,
  };
  let baseline;
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const comparison = baseline ? compare(baseline, current) : { status: 'baseline', rows: [] };
  if (!baseline) await writeFile(baselinePath, JSON.stringify(current, null, 2), { flag: 'wx' });
  const report = { schemaVersion: 1, baseline: baseline ?? current, current, comparison };
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2));
  await rename(`${reportPath}.tmp`, reportPath);
  console.log(`[perf] ${comparison.status}; report: ${reportPath}`);
  for (const row of comparison.rows.filter(
    (row) => row.name.startsWith('rust/ipc_dispatch/') || row.regression,
  ))
    console.log(JSON.stringify(row));
} catch (error) {
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify({ runId, error: error.stack }, null, 2),
  );
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await server?.close();
}
