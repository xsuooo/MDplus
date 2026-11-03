import { afterEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSourceManifest, bindSource } from '../scripts/source-manifest.mjs';

// Each capture runs two bounded, real Windows attribute probes; startup can exceed 5s.
vi.setConfig({ testTimeout: 60000 });

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mdplus-source-manifest-'));
  roots.push(root);
  await put(root, 'package.json', '{"name":"fixture","version":"1.0.0"}');
  await put(root, 'package-lock.json', '{"lockfileVersion":3}');
  await put(root, 'src/main.ts', 'export const value = 1;');
  await put(root, 'public/font.txt', 'public font license');
  await put(root, 'src-tauri/src/main.rs', 'fn main() {}');
  await put(root, 'src-tauri/Cargo.toml', '[package]\nname = "fixture"');
  await put(root, 'tests/fixture.test.ts', 'test fixture');
  await put(root, 'scripts/check.mjs', 'check fixture');
  await put(root, '.github/workflows/ci.yml', 'name: fixture');
  await put(root, 'tsconfig.browser.json', '{}');
  await put(root, 'index.html', '<div id="root"></div>');
  return root;
}
async function put(root: string, path: string, value: string | Uint8Array) {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, value);
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('source manifest content binding (TEST-SOURCE)', () => {
  it('001 hashes every selected untracked input without consulting Git', async () => {
    const root = await fixture();
    const before = await createSourceManifest(root);
    await put(root, 'src/untracked.ts', 'first');
    const added = await createSourceManifest(root);
    expect(added.digest).not.toBe(before.digest);
    const path = join(root, 'src/untracked.ts');
    const original = await stat(path);
    await writeFile(path, 'other'); // Same byte length, restore mtime below.
    await utimes(path, original.atime, original.mtime);
    const changed = await createSourceManifest(root);
    expect(changed.digest).not.toBe(added.digest);
    const record = changed.files.find((file: { path: string }) => file.path === 'src/untracked.ts');
    expect(record).toEqual({ path: 'src/untracked.ts', bytes: 5, sha256: createHash('sha256').update('other').digest('hex') });
  });

  it('002 ignores generated artifacts and private/profile files without hashing their contents', async () => {
    const root = await fixture();
    const before = await createSourceManifest(root);
    for (const path of ['.audit/results.json', 'node_modules/module/index.js', 'dist/app.js',
      'src-tauri/target/debug/app.exe', 'src-tauri/gen/schemas/acl.json', '.env', '.env.local',
      '.npmrc', 'user-profile/settings.json', 'profiles/draft.md', 'src/.env.local']) {
      await put(root, path, 'ignored synthetic data');
    }
    expect(await createSourceManifest(root)).toEqual(before);
  });

  it('003 is root-independent and byte-order sorted; touching files does not change the digest', async () => {
    const first = await fixture();
    const second = await fixture();
    await put(first, 'src/中文.ts', 'unicode'); await put(first, 'src/Z.ts', 'last');
    await put(second, 'src/Z.ts', 'last'); await put(second, 'src/中文.ts', 'unicode');
    const manifest = await createSourceManifest(first);
    expect(await createSourceManifest(second)).toEqual(manifest);
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(
      manifest.files.map((file: { path: string }) => file.path).sort((a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    );
    await utimes(join(first, 'src/main.ts'), new Date(0), new Date(0));
    expect(await createSourceManifest(first)).toEqual(manifest);
    expect(JSON.stringify(manifest)).not.toContain(first);
  });

  it('004 rejects changed source between the check/build snapshots', async () => {
    const root = await fixture();
    const before = await createSourceManifest(root);
    await put(root, 'src/main.ts', 'export const value = 2;');
    const after = await createSourceManifest(root);
    expect(() => bindSource('Build', before, after)).toThrow(/changed/i);
  });

  it('005 binds unchanged Build input and embeds the actual content manifest', async () => {
    const root = await fixture();
    const before = await createSourceManifest(root);
    expect(bindSource('Build', before, await createSourceManifest(root))).toEqual({ status: 'observed-stable', manifest: before });
  });

  it('006 never attributes the current tree to an Existing package', async () => {
    const current = await createSourceManifest(await fixture());
    const binding = bindSource('Existing', current, current);
    expect(binding.status).toBe('unknown');
    expect(binding.manifest).toBeNull();
    expect(JSON.stringify(binding)).not.toContain(current.digest);
  });

  it('007 rejects an included directory link instead of traversing outside the root', async () => {
    const root = await fixture();
    const outside = await fixture();
    const link = join(root, 'src/linked');
    await symlink(join(outside, 'src'), link, process.platform === 'win32' ? 'junction' : 'dir');
    try { await expect(createSourceManifest(root)).rejects.toThrow(/link|outside|reparse/i); }
    finally { await rm(link); }
  });

  it('008 rejects a symlinked repository root', async () => {
    const parent = await fixture();
    const target = await fixture();
    const link = join(parent, 'alias');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    try { await expect(createSourceManifest(link)).rejects.toThrow(/link|outside|reparse/i); }
    finally { await rm(link); }
  });

  it('009 rejects tampered, duplicate, and escaping manifest records', async () => {
    const current = await createSourceManifest(await fixture());
    for (const bad of [
      { ...current, digest: '0'.repeat(64) },
      { ...current, files: [...current.files, current.files[0]] },
      { ...current, files: [{ path: '../outside', bytes: 0, sha256: '0'.repeat(64) }] },
    ]) expect(() => bindSource('Build', bad, bad)).toThrow(/manifest|path|digest|duplicate|order/i);
    expect(() => bindSource('Other', current, current)).toThrow(/mode/i);
  });

  it('010 exposes the same capture/bind behavior through the delivery CLI', async () => {
    const root = await fixture();
    const script = resolve('scripts/source-manifest.mjs');
    const captured = spawnSync(process.execPath, [script, 'capture', root], { encoding: 'utf8' });
    expect(captured.status, captured.stderr).toBe(0);
    const manifest = JSON.parse(captured.stdout);
    expect(manifest).toEqual(await createSourceManifest(root));
    const before = join(root, 'before.json'); const after = join(root, 'after.json');
    await writeFile(before, captured.stdout); await writeFile(after, captured.stdout);
    const bound = spawnSync(process.execPath, [script, 'bind', 'Build', before, after], { encoding: 'utf8' });
    expect(bound.status, bound.stderr).toBe(0);
    expect(JSON.parse(bound.stdout).manifest.digest).toBe(manifest.digest);
    await put(root, 'src/main.ts', 'changed while building');
    await writeFile(after, JSON.stringify(await createSourceManifest(root)));
    const conflict = spawnSync(process.execPath, [script, 'bind', 'Build', before, after], { encoding: 'utf8' });
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toMatch(/changed/i);
    const existing = spawnSync(process.execPath, [script, 'bind', 'Existing'], { encoding: 'utf8' });
    expect(existing.status, existing.stderr).toBe(0);
    expect(JSON.parse(existing.stdout).status).toBe('unknown');
    expect(await readFile(before, 'utf8')).toBe(captured.stdout);
  }, 60000);

  it.runIf(process.platform === 'win32')('011 fails closed when the Windows attribute probe fails or returns an invalid acknowledgement', async () => {
    const root = await fixture();
    const probe = vi.spyOn(childProcess, 'spawnSync');
    for (const result of [
      { status: 1, stdout: '', stderr: 'synthetic attribute refusal', signal: null },
      { status: null, stdout: '', stderr: '', signal: null, error: new Error('synthetic timeout') },
      { status: 0, stdout: '', stderr: '', signal: null },
    ]) {
      probe.mockReturnValueOnce(result as ReturnType<typeof spawnSync>);
      await expect(createSourceManifest(root)).rejects.toThrow(/attributes|reparse|probe/i);
    }
    expect(probe).toHaveBeenCalledTimes(3);
    const [command, args, options] = probe.mock.calls[0];
    expect(String(command).toLowerCase()).toMatch(/windowspowershell/);
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    expect(args).not.toContain('-ExecutionPolicy');
    expect(args).not.toContain(root);
    expect(options?.input).toContain(JSON.stringify(root).slice(1, -1));
  });

  it('012 rejects impossible file/directory topology even when its digest is recomputed', async () => {
    const current = await createSourceManifest(await fixture());
    const file = current.files[0];
    for (const files of [
      [{ ...file, path: 'src' }],
      [{ ...file, path: 'src/item' }, { ...file, path: 'src/item/child.ts' }],
      [{ ...file, path: 'src/ITEM/child.ts' }, { ...file, path: 'src/item' }],
    ]) {
      const bad = { ...current, files, digest: createHash('sha256').update('mdplus-source-v1\n' + JSON.stringify(files)).digest('hex') };
      expect(() => bindSource('Build', bad, bad)).toThrow(/manifest|path|directory|policy/i);
    }
  });

  it('013 rejects malformed CLI JSON without echoing input contents', async () => {
    const root = await fixture();
    const file = join(root, 'invalid.json');
    await writeFile(file, 'SYNTHETIC_PRIVATE_MARKER: not json');
    const result = spawnSync(process.execPath, [resolve('scripts/source-manifest.mjs'), 'bind', 'Build', file, file], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('SYNTHETIC_');
    expect(result.stderr).toMatch(/invalid.*manifest.*json/i);
  });

  it('014 hashes raw bytes and a canonical aggregate against an independent SHA-256 vector', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mdplus-source-vector-'));
    roots.push(root);
    await put(root, 'src/abc.txt', Buffer.from([97, 98, 99]));
    const manifest = await createSourceManifest(root);
    expect(manifest).toEqual({
      schema: 1, algorithm: 'sha256', policy: 'mdplus-source-v1',
      files: [{ path: 'src/abc.txt', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }],
      // SHA256SUM of the documented domain + canonical file list, independently checked with sha256sum.
      digest: '48af8aa55ca6b404e249033b5b789d50389c23998c1c03267ddac1d074c24432',
    });
    await put(root, 'src/abc.txt', Buffer.from([0, 255, 128]));
    const binary = await createSourceManifest(root);
    expect(binary.files[0].bytes).toBe(3);
    expect(binary.files[0].sha256).toBe(createHash('sha256').update(Buffer.from([0, 255, 128])).digest('hex'));
    expect(binary.digest).not.toBe(manifest.digest);
  });

  it('015 rejects a same-length write with restored mtime between enumeration and open', async () => {
    const root = await fixture();
    const target = join(root, 'src/main.ts');
    const original = await stat(target);
    const open = fs.open.bind(fs);
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (path === target && !changed) {
        changed = true;
        await writeFile(target, 'export const value = 2;');
        await utimes(target, original.atime, original.mtime);
      }
      return open(path, flags, mode);
    });
    await expect(createSourceManifest(root)).rejects.toThrow(/changed/i);
    expect(changed).toBe(true);
  });

  it('016 rejects a write during the opened-handle byte read and closes the handle', async () => {
    const root = await fixture();
    const target = join(root, 'src/main.ts');
    const open = fs.open.bind(fs);
    let closed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (path === target) {
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'read').mockImplementationOnce(async (...args: Parameters<typeof handle.read>) => {
          const value = await read(...args);
          await writeFile(target, 'changed while reading!!');
          return value;
        });
        vi.spyOn(handle, 'close').mockImplementation(async () => { closed = true; await close(); });
      }
      return handle;
    });
    await expect(createSourceManifest(root)).rejects.toThrow(/changed/i);
    expect(closed).toBe(true);
  });

  it('017 rejects a newly included file added after enumeration', async () => {
    const root = await fixture();
    const target = join(root, 'src/main.ts');
    const open = fs.open.bind(fs);
    let added = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (path === target && !added) { added = true; await put(root, 'src/late.ts', 'late'); }
      return open(path, flags, mode);
    });
    await expect(createSourceManifest(root)).rejects.toThrow(/changed/i);
    expect(added).toBe(true);
  });

  it('018 rejects ancestor junctions and external hard links without reading linked data', async () => {
    const root = await fixture();
    const outside = await fixture();
    const alias = join(root, 'alias');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try { await expect(createSourceManifest(join(alias, 'src'))).rejects.toThrow(/link|reparse|outside/i); }
    finally { await rm(alias); }
    await fs.link(join(outside, 'src/main.ts'), join(root, 'src/hard-linked.ts'));
    const open = vi.spyOn(fs, 'open');
    await expect(createSourceManifest(root)).rejects.toThrow(/link/i);
    expect(open).not.toHaveBeenCalled();
  });

  it('019 rejects malformed schemas, noncanonical names, unknown keys and invalid byte records', async () => {
    const current = await createSourceManifest(await fixture());
    for (const bad of [null, [], { ...current, schema: '1' }, { ...current, algorithm: 'SHA256' },
      { ...current, policy: 'unknown' }, { ...current, extra: true }, { ...current, files: [] },
      { ...current, files: [null] }, { ...current, files: new Array(1) },
      { ...current, files: [...current.files].reverse() }, { ...current, digest: current.digest.toUpperCase() },
    ]) expect(() => bindSource('Build', bad, bad)).toThrow(/manifest|digest|order/i);
    const file = current.files[0];
    for (const path of ['/src/a', '../outside', 'src/../outside', 'src//a', 'src/./a', 'C:/escape',
      'src/a:stream', 'src/line\nbreak', 'src/a\\b', 'src/NUL.txt', 'src/tail.', 'src/tail ', 'src/.env.local', '.audit/private.json']) {
      const bad = { ...current, files: [{ ...file, path }] };
      expect(() => bindSource('Build', bad, bad)).toThrow(/manifest|path|policy/i);
    }
    for (const record of [{ ...file, bytes: -1 }, { ...file, bytes: -0 }, { ...file, bytes: 1.1 },
      { ...file, bytes: '1' }, { ...file, bytes: Number.MAX_SAFE_INTEGER + 1 }, { ...file, sha256: 'xyz' },
      { ...file, sha256: file.sha256.toUpperCase() }, { ...file, extra: 'ignored?' }]) {
      const bad = { ...current, files: [record] };
      expect(() => bindSource('Build', bad, bad)).toThrow(/manifest|record/i);
    }
    expect(() => bindSource('Build', current)).toThrow(/two|manifests/i);
    const binding = bindSource('Build', current, current, current);
    current.files[0].sha256 = '0'.repeat(64);
    expect(binding.manifest.files[0].sha256).not.toBe(current.files[0].sha256);
  });

  it.runIf(process.platform === 'win32')('020 passes real attribute probes with Unicode and PowerShell metacharacters as literal path data', async () => {
    const root = await fixture();
    const name = "src/中文 $(throw 'must-not-run').ts";
    await put(root, name, 'abc');
    const probe = vi.spyOn(childProcess, 'spawnSync');
    const manifest = await createSourceManifest(root);
    expect(manifest.files.find((file: { path: string }) => file.path === name)?.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(probe).toHaveBeenCalledTimes(2);
    for (const [, args, options] of probe.mock.calls) {
      expect(args?.join(' ')).not.toContain(name);
      expect(options?.input).toContain('must-not-run');
      expect(options?.shell).toBe(false);
    }
  });

  it('023 preserves a leading Unicode BOM character in filenames rather than silently decoding another path', async () => {
    const root = await fixture();
    const name = 'src/\uFEFFname.ts';
    await put(root, name, 'abc');
    const manifest = await createSourceManifest(root);
    expect(manifest.files.some((file: { path: string }) => file.path === name)).toBe(true);
  });

  it('024 rejects invalid CLI arguments, oversized manifests and a non-directory source root', async () => {
    const root = await fixture();
    const script = resolve('scripts/source-manifest.mjs');
    for (const args of [[], ['unknown'], ['capture'], ['capture', root, 'extra'], ['bind', 'Build'], ['bind', 'Existing', 'extra']]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toMatch(/usage/i);
    }
    const large = join(root, 'too-large.json');
    await writeFile(large, '{}'); await fs.truncate(large, 16 * 1024 * 1024 + 1);
    const result = spawnSync(process.execPath, [script, 'bind', 'Build', large, large], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toMatch(/size/i);
    await expect(createSourceManifest(join(root, 'package.json'))).rejects.toThrow(/director/i);
  });

  it('025 checks every Build snapshot, including the third post-build capture', async () => {
    const root = await fixture();
    const before = await createSourceManifest(root);
    await put(root, 'src/main.ts', 'changed only by the build');
    const built = await createSourceManifest(root);
    expect(() => bindSource('Build', before, before, built)).toThrow(/changed/i);
    expect(bindSource('Existing', before, built)).toEqual({ status: 'unknown', manifest: null });
  });

  it('026 includes native packaging/config inputs and ignores private/generated paths without opening them', async () => {
    const root = await fixture();
    const included = ['src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'src-tauri/icons/icon.ico',
      'src-tauri/installer/hooks.nsh', '.cargo/config.toml', 'vite.config.ts', 'vitest.config.ts'];
    const excluded = ['src/.NPMRC', 'src/credentials.json', 'src/token.pem', 'src/app.local.json', 'src/node_modules/x/index.js',
      'tests/test-results/result.json', 'public/.env.production', 'src-tauri/gen/schemas/desktop-schema.json'];
    for (const path of [...included, ...excluded]) await put(root, path, 'synthetic');
    const open = vi.spyOn(fs, 'open');
    const manifest = await createSourceManifest(root);
    const paths = manifest.files.map((file: { path: string }) => file.path);
    for (const path of included) expect(paths).toContain(path);
    for (const path of excluded) {
      expect(paths).not.toContain(path);
      expect(open.mock.calls.some(([opened]) => opened === join(root, path))).toBe(false);
    }
  });

  it('027 rejects duplicate JSON keys rather than accepting parser-dependent source evidence', async () => {
    const root = await fixture();
    const current = await createSourceManifest(root);
    const file = join(root, 'duplicate.json');
    await writeFile(file, JSON.stringify(current).replace('"schema":1', '"schema":0,"schema":1'));
    const result = spawnSync(process.execPath, [resolve('scripts/source-manifest.mjs'), 'bind', 'Build', file, file], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toMatch(/invalid.*manifest.*json/i);
  });
});

type AstCommand = { name: string; text: string; start: number; end: number };
type DeliveryAst = {
  commands: AstCommand[];
  assignments: { left: string; right: string; start: number }[];
  branches: { condition: string; start: number; end: number }[];
};
function deliveryAst(): DeliveryAst {
  // ParseFile only: never dot-source, import, compile, or evaluate project PowerShell.
  const command = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:MDPLUS_SOURCE_TEST_DELIVERY, [ref]$tokens, [ref]$errors)
if ($errors.Count) { [Console]::Error.Write('Delivery PowerShell parse errors'); exit 2 }
$commands = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
  @{ name = $_.GetCommandName(); text = $_.Extent.Text; start = $_.Extent.StartOffset; end = $_.Extent.EndOffset }
})
$assignments = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] }, $true) | ForEach-Object {
  @{ left = $_.Left.Extent.Text; right = $_.Right.Extent.Text; start = $_.Extent.StartOffset }
})
$branches = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.IfStatementAst] }, $true) | ForEach-Object {
  foreach ($clause in $_.Clauses) { @{ condition = $clause.Item1.Extent.Text; start = $clause.Item2.Extent.StartOffset; end = $clause.Item2.Extent.EndOffset } }
})
[Console]::Out.Write((@{ commands = $commands; assignments = $assignments; branches = $branches } | ConvertTo-Json -Depth 8 -Compress))
`;
  const result = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', shell: false, timeout: 30000, env: { ...process.env, MDPLUS_SOURCE_TEST_DELIVERY: resolve('scripts/windows/deliver.ps1') } });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe.runIf(process.platform === 'win32')('delivery source binding (static AST, not native execution)', () => {
  it('021 places stable bindings around this invocation checks and build before publication', () => {
    const ast = deliveryAst();
    const branch = ast.branches.find((item) => item.condition === '$Build' || item.condition === "$mode -eq 'Build'");
    expect(branch).toBeDefined();
    const commands = ast.commands.filter((item) => item.start > branch!.start && item.end < branch!.end);
    const positions = [
      /Invoke-SourceJson.*source-before-checks/,
      /npm\.cmd run check/,
      /Invoke-SourceJson.*source-after-checks/,
      /Invoke-SourceJson.*source-checks-binding/,
      /npm\.cmd run tauri -- build/,
      /Invoke-SourceJson.*source-after-build/,
      /Invoke-SourceJson.*source-build-binding/,
    ].map((pattern) => commands.findIndex((item) => pattern.test(item.text)));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const finalBind = commands[positions[6]].text;
    expect(finalBind).toContain('$beforePath'); expect(finalBind).toContain('$afterChecksPath'); expect(finalBind).toContain('$afterBuildPath');
    expect(ast.commands.find((item) => item.name === 'Publish-Delivery')!.start).toBeGreaterThan(commands[positions[6]].start);
  });

  it('022 leaves Existing source/build/check provenance unknown and preserves schema-1 four-file staging', () => {
    const ast = deliveryAst();
    const build = ast.branches.find((item) => item.condition === "$mode -eq 'Build'")!;
    expect(build).toBeDefined();
    const identityCalls = ast.commands.filter((item) => item.name === 'Get-ReleaseIdentity' || item.name === 'git');
    expect(identityCalls.length).toBeGreaterThan(0);
    expect(identityCalls.every((item) => item.start > build.start && item.end < build.end)).toBe(true);
    for (const variable of ['$sourceHead', '$sourceWorktreeDirty']) {
      expect(ast.assignments.find((item) => item.left === variable)?.right).toBe('$null');
    }
    // A fixed native exit=17 microcheck established that a local sentinel shadows the real exit.
    expect(ast.assignments.find((item) => item.left === '$global:LASTEXITCODE')?.right).toBe('$null');
    expect(ast.assignments.find((item) => item.left === '$code')?.right).toBe('$global:LASTEXITCODE');
    const unknown = ast.assignments.find((item) => item.left === '$source')!.right;
    expect(unknown).toMatch(/status\s*=\s*'unknown'/); expect(unknown).toContain('manifest = $null');
    const existingIdentity = ast.assignments.filter((item) => item.left === '$identity').find((item) => item.start > build.end)!.right;
    expect(existingIdentity).toContain('build = $null');
    const manifest = ast.assignments.find((item) => item.left === '$manifest')!.right;
    expect(manifest).toMatch(/schema\s*=\s*1/); expect(manifest).toContain('source = $source');
    const staged = ast.commands.filter((item) => ['Write-AtomicText', 'Write-AtomicJson'].includes(item.name) && item.text.includes('$staging'));
    expect(staged).toHaveLength(3);
    for (const file of ['README.txt', 'manifest.json', 'SHA256SUMS']) expect(staged.some((item) => item.text.includes(file))).toBe(true);
  });
});
