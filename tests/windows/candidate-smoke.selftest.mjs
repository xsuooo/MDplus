import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const sourcePath = resolve('tests/windows/candidate-smoke.ps1');
const source = () => readFileSync(sourcePath, 'utf8');
const fn = (name) => {
  const text = source();
  const begin = text.indexOf(`function ${name}(`);
  assert.notEqual(begin, -1, `missing safety boundary ${name}`);
  const next = text.indexOf('\nfunction ', begin + 1);
  return text.slice(begin, next === -1 ? text.length : next);
};

test('candidate smoke script exists', () => assert.ok(existsSync(sourcePath), 'candidate-smoke.ps1 is not implemented yet'));
test('host refusal precedes manifest reads, writes and launch', () => {
  const main = fn('Invoke-CandidateSmoke');
  assert.ok(main.indexOf('Assert-SmokeHost') >= 0);
  assert.ok(main.indexOf('Assert-SmokeHost') < main.indexOf('Get-Content'));
  assert.ok(main.indexOf('Assert-SmokeContext') < main.indexOf('CreateDirectory'));
  const guard = fn('Assert-SmokeHost');
  assert.match(guard, /\$Machine\s*-ieq\s*\$HostComputerName/);
  assert.match(guard, /throw\s+'REFUSED_HOST/);
});
test('sandbox context is not only a user-supplied flag', () => {
  const guard = fn('Assert-SmokeContext');
  for (const marker of ['WDAGUtilityAccount', 'Microsoft Corporation', 'Virtual Machine',
    'C:\\MDPlusCandidateInput', 'C:\\MDPlusCandidateResults', 'mdplus-candidate-smoke/v1']) {
    assert.ok(guard.includes(marker), `missing sandbox check ${marker}`);
  }
  const main = fn('Invoke-CandidateSmoke');
  assert.match(main, /\[Environment\]::MachineName/);
  assert.match(main, /\[Environment\]::UserName/);
  assert.match(main, /Get-CimInstance Win32_ComputerSystem/);
});
test('hash predicate and launch order reject mismatched bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mdplus-smoke-static-'));
  try {
    const file = join(directory, 'non-executable.fixture');
    writeFileSync(file, 'candidate fixture');
    const first = createHash('sha256').update(readFileSync(file)).digest('hex');
    writeFileSync(file, 'changed fixture');
    const second = createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.notEqual(first, second);
    assert.match(fn('Assert-SmokeHash'), /\$Actual\s*-ine\s*\$Expected/);
    const launch = fn('Start-SmokeCandidate');
    assert.ok(launch.indexOf('Assert-SmokeHash') < launch.indexOf('[Diagnostics.Process]::Start'));
    assert.ok(launch.includes('Assert-SmokeNoOtherEditor'));
  } finally { rmSync(directory, { recursive: true }); }
});
test('PID reuse and foreign executables are rejected before control', () => {
  const guard = fn('Assert-SmokeIdentity');
  for (const check of [/\$Actual\.Id\s*-ne\s*\$Expected\.Id/, /\$Actual\.StartTicks\s*-ne\s*\$Expected\.StartTicks/,
    /\$Actual\.Path\s*-ine\s*\$Expected\.Path/, /\$Actual\.Exited/]) assert.match(guard, check);
  const action = fn('Invoke-SmokePattern');
  assert.ok(action.indexOf('Assert-SmokeElement') < action.indexOf('TryGetCurrentPattern'));
  const close = fn('Close-SmokeCandidate');
  assert.ok(close.indexOf('Get-SmokeOwnedProcess') < close.indexOf('.CloseMainWindow('));
});
test('no install, force stop, coordinates, policy, registry, global env or Sandbox launch', () => {
  assert.doesNotMatch(source(), /Stop-Process|taskkill|Set-ExecutionPolicy|WindowsSandbox\.exe|SetCursorPos|mouse_event|SendInput|SendWait|\.Kill\(|\.Terminate\(|SetEnvironmentVariable|CreateSubKey|HKLM:|HKCU:|\$env:\w+\s*=/i);
});
test('automation reports blocked/manual separately and validates real outputs', () => {
  const text = source();
  for (const marker of ['blocked', 'manual', 'not_run', 'candidateAccepted', 'UIA ValuePattern',
    '打印 / 另存为 PDF', '%PDF-', '%%EOF', 'data:image/png;base64,', 'Get-FileHash']) assert.ok(text.includes(marker), marker);
});
test('Windows PowerShell parser accepts the script without executing it', () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile('tests/windows/candidate-smoke.ps1',[ref]$t,[ref]$e)|Out-Null;$e|ForEach-Object{[Console]::Error.WriteLine($_.Message)};if($e.Count){exit 1}"],
  { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// These are syntax/data-flow tripwires, not an execution of any PowerShell body.
let astCache;
function syntaxAudit() {
  if (astCache) return astCache;
  const query = String.raw`
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$t=$null; $e=$null
$a=[Management.Automation.Language.Parser]::ParseFile('tests/windows/candidate-smoke.ps1',[ref]$t,[ref]$e)
if ($e.Count) { $e | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }
$functions=@($a.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | ForEach-Object {
  $f=$_
  [ordered]@{
    name=$f.Name
    calls=@($f.Body.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true) | ForEach-Object {
      [ordered]@{name=$_.GetCommandName();text=$_.Extent.Text;offset=$_.Extent.StartOffset;operator=[string]$_.InvocationOperator}
    })
    members=@($f.Body.FindAll({param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst]},$true) | ForEach-Object {
      [ordered]@{name=$_.Member.Extent.Text;target=$_.Expression.Extent.Text;offset=$_.Extent.StartOffset;args=@($_.Arguments | ForEach-Object {$_.Extent.Text})}
    })
    binary=@($f.Body.FindAll({param($n) $n -is [Management.Automation.Language.BinaryExpressionAst]},$true) | ForEach-Object {
      [ordered]@{left=$_.Left.Extent.Text;operator=[string]$_.Operator;right=$_.Right.Extent.Text}
    })
    strings=@($f.Body.FindAll({param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst]},$true) | ForEach-Object {$_.Value})
    throws=@($f.Body.FindAll({param($n) $n -is [Management.Automation.Language.ThrowStatementAst]},$true) | ForEach-Object {$_.Extent.Text})
    assignments=@($f.Body.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst]},$true) | ForEach-Object {
      [ordered]@{left=$_.Left.Extent.Text;right=$_.Right.Extent.Text;offset=$_.Extent.StartOffset}
    })
    pairs=@($f.Body.FindAll({param($n) $n -is [Management.Automation.Language.HashtableAst]},$true) | ForEach-Object {
      $_.KeyValuePairs | ForEach-Object { [ordered]@{key=$_.Item1.Extent.Text;value=$_.Item2.Extent.Text} }
    })
  }
})
[ordered]@{functions=$functions;parameters=@($a.ParamBlock.Parameters | ForEach-Object {$_.Name.VariablePath.UserPath})} | ConvertTo-Json -Depth 12 -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
    { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  astCache = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  return astCache;
}
const astFn = (name) => {
  const matches = syntaxAudit().functions.filter((item) => item.name === name);
  assert.equal(matches.length, 1, 'expected one executable function ' + name);
  return matches[0];
};

test('PowerShell 5.1 decodes real Unicode selectors and only exposes fixed contract inputs', () => {
  assert.equal(readFileSync(sourcePath).subarray(0, 3).toString('hex'), 'efbbbf', 'Windows PowerShell needs a UTF-8 BOM');
  assert.deepEqual(syntaxAudit().parameters, ['HostComputerName', 'ExpectedExeSha256', 'RunId']);
  const strings = syntaxAudit().functions.flatMap((item) => item.strings);
  for (const label of ['Markdown 源码', '切换源码模式', '导出为 HTML', '导出为 PDF']) assert.ok(strings.includes(label), label);
});
test('real guard expressions reject machine identity, hash and process stamp mismatches', () => {
  const expectComparison = (name, left, operator, right) => assert.ok(astFn(name).binary.some((b) =>
    b.left === left && b.operator === operator && b.right === right), name + ': ' + left + ' ' + operator + ' ' + right);
  expectComparison('Assert-SmokeHost', '$Machine', 'Ieq', '$HostComputerName');
  expectComparison('Assert-SmokeHash', '$Actual', 'Ine', '$Expected');
  for (const field of ['Id', 'StartTicks']) expectComparison('Assert-SmokeIdentity', '$Actual.' + field, 'Ine', '$Expected.' + field);
  expectComparison('Assert-SmokeIdentity', '$Actual.Path', 'Ine', '$Expected.Path');
  for (const name of ['Assert-SmokeHost', 'Assert-SmokeContext', 'Assert-SmokeHash', 'Assert-SmokeIdentity', 'Assert-SmokeInside']) {
    assert.ok(astFn(name).throws.length, name);
    assert.ok(astFn(name).members.every((m) => !['Start', 'SetValue', 'Invoke', 'CloseMainWindow', 'WriteAllText', 'Copy'].includes(m.name)), name);
  }
});
test('all native side effects use owned process and UIA boundaries, never eval or fallback input', () => {
  const functions = syntaxAudit().functions;
  for (const f of functions) {
    for (const call of f.calls) {
      assert.notEqual(call.operator, 'Dot', f.name);
      assert.ok(!['Invoke-Expression', 'Start-Process', 'Set-Clipboard'].includes(call.name), f.name);
    }
    for (const m of f.members) {
      if (m.name === 'Start' && m.target === '[Diagnostics.Process]') assert.equal(f.name, 'Start-SmokeCandidate');
      if (['SetValue', 'Invoke', 'Select', 'Expand', 'SetFocus'].includes(m.name)
        && !(f.name === 'Wait-SmokeWinRt' && m.name === 'Invoke' && m.target === '$taskMethod')) assert.equal(f.name, 'Invoke-SmokePattern');
      if (m.name === 'CloseMainWindow') assert.equal(f.name, 'Close-SmokeCandidate');
      assert.ok(!['GetScriptBlock', 'Kill', 'Terminate', 'SendWait'].includes(m.name), f.name + '.' + m.name);
      assert.ok(!(m.name === 'Create' && /scriptblock/i.test(m.target)), f.name);
    }
  }
  const main = astFn('Invoke-CandidateSmoke');
  const callOffset = (name) => main.calls.find((c) => c.name === name)?.offset ?? Infinity;
  assert.ok(callOffset('Assert-SmokeHost') < callOffset('Get-Content'));
  assert.ok(callOffset('Assert-SmokeContext') < callOffset('Get-Content'), 'real VM gate must also precede sentinel read');
  assert.ok(callOffset('Assert-SmokeContext') < main.members.find((m) => m.name === 'CreateDirectory')?.offset);
  assert.ok(astFn('Get-SmokeOwnedProcess').calls.some((c) => c.name === 'Assert-SmokeIdentity'));
  assert.ok(astFn('Assert-SmokeElement').calls.some((c) => c.name === 'Get-SmokeOwnedProcess'));
});
test('lineage, reparse checks and create-new output are real code, not comment markers', () => {
  assert.ok(astFn('Get-SmokeOwnedProcess').binary.some((b) => b.left.includes('ParentProcessId')));
  assert.ok(astFn('Assert-SmokePlainPath').binary.some((b) => b.operator === 'Band' && b.right.includes('ReparsePoint')));
  assert.ok(astFn('Write-SmokeNewFile').members.some((m) => m.name === 'Open' && m.args.includes('[IO.FileMode]::CreateNew')));
  assert.ok(astFn('Start-SmokeCandidate').calls.some((c) => c.name === 'Assert-SmokeNoOtherEditor'));
  assert.ok(astFn('Start-SmokeCandidate').members.some((m) => m.name === 'Open' && m.args.includes('[IO.FileShare]::Read')));
});
test('automated PDF verification reads produced bytes and page/xref structure; acceptance remains manual', () => {
  const pdf = astFn('Test-SmokePdf');
  assert.ok(pdf.calls.some((c) => c.name === 'Get-SmokeFileBytes'));
  for (const marker of ['%PDF-', '%%EOF', 'startxref', '/Type']) assert.ok(pdf.strings.some((s) => s.includes(marker)), marker);
  assert.ok(pdf.members.some((m) => m.name === 'LoadFromFileAsync' && m.target.includes('Windows.Data.Pdf.PdfDocument')));
  assert.ok(pdf.members.some((m) => m.name === 'GetPage'));
  assert.match(fn('Test-SmokePdf'), /\$document\.PageCount/);
  assert.match(fn('Invoke-CandidateSmoke'), /candidateAccepted\s*=\s*\$false/);
  assert.match(fn('Invoke-CandidateSmoke'), /sourceDigestVerified\s*=\s*\$false/);
  assert.match(fn('Invoke-CandidateSmoke'), /'manual'/);
});
test('scoped UIA lookups register descendants before checking element ownership', () => {
  const lookup = astFn('Find-SmokeElement');
  assert.equal(lookup.calls[0].name, 'Update-SmokeChildren');
});
test('print buttons are confined to a named preview and destination is revalidated', () => {
  const preview = astFn('Get-SmokePrintPreview');
  assert.ok(preview.strings.includes('打印') && preview.strings.includes('Print'));
  const button = astFn('Get-SmokePrintButton');
  assert.ok(button.calls.some((c) => c.name === 'Assert-SmokePdfDestination'));
  assert.ok(button.calls.filter((c) => c.name === 'Find-SmokeElement').every((c) => c.text.includes('-Within $Preview.Panel')));
  assert.ok(!button.members.some((m) => m.name === 'GetParent'), 'button lookup must not climb into the normal editor toolbar');
});
test('sentinel identity types and regexes cannot accept arrays or trailing newlines', () => {
  const context = astFn('Assert-SmokeContext');
  for (const field of ['purpose','hostComputerName','runId']) {
    assert.ok(context.binary.some((b) => b.left === '$sentinel.' + field && b.operator === 'IsNot' && b.right === '[string]'), field);
  }
  assert.ok(context.strings.some((s) => s.includes('{0,63}') && s.endsWith('\\z')));
});
test('evidence write failure is reflected in the final stdout status and exit code', () => {
  const main = fn('Invoke-CandidateSmoke');
  const failure = main.indexOf('BLOCKED_EVIDENCE:');
  assert.ok(failure >= 0);
  assert.ok(main.indexOf('$report.exitCode=$code', failure) > failure);
  assert.ok(main.indexOf('ConvertTo-Json', failure) > failure);
});

test('post-launch safety refusal is blocked, never mislabeled as preflight refusal', () => {
  assert.match(fn('Invoke-CandidateSmoke'), /if \(\$stage -eq 'preflight' -and \$report\.error -like 'REFUSED_\*'\)/);
});
test('missing UIA assemblies are an explicit capability block before launch', () => {
  const main = astFn('Invoke-CandidateSmoke');
  assert.ok(main.throws.some((t) => t.includes('BLOCKED_UIA: required Windows automation assemblies unavailable')));
});

test('each launch resets cleanup and records creation facts before fallible identity capture', () => {
  const launch = astFn('Start-SmokeCandidate');
  const start = launch.members.find((m) => m.name === 'Start' && m.target === '[Diagnostics.Process]').offset;
  const stamp = launch.calls.find((c) => c.name === 'Get-SmokeStamp').offset;
  assert.ok(launch.assignments.some((a) => a.left === '$State.Report.cleanup' && a.right === "'not_run'" && a.offset < start));
  assert.ok(launch.assignments.some((a) => a.left === '$State.Report.cleanup' && a.right.includes('blocked:') && a.offset < start));
  for (const [left, right] of [['$State.Launch.started','$true'],['$State.Launch.observedPid','$process.Id']]) {
    assert.ok(launch.assignments.some((a) => a.left === left && a.right === right && a.offset > start && a.offset < stamp), left);
  }
  assert.ok(launch.assignments.some((a) => a.left === '$State.Launch.identityCaptureError'));
  assert.ok(!launch.members.some((m) => m.name === 'GetProcessById'), 'unverified observed PID is evidence only, never a control handle');
});
test('cleanup success explicitly covers only the root and recorded descendants', () => {
  const main = astFn('Invoke-CandidateSmoke');
  assert.ok(main.pairs.some((p) => p.key === 'cleanupScope' && p.value === "'root-and-recorded-descendants'"));
  assert.ok(main.pairs.some((p) => p.key === 'unobservedDescendants' && p.value === "'not_verified'"));
  assert.ok(main.pairs.some((p) => p.key === 'name' && p.value === "'Unobserved descendants after the last process snapshot'"));
});
test('final print Invoke revalidates destination and exact button semantics inside the guarded action', () => {
  const action = astFn('Invoke-SmokePattern');
  const invoke = action.members.find((m) => m.name === 'Invoke' && m.target === '$pattern').offset;
  assert.ok(action.calls.some((c) => c.name === 'Assert-SmokePdfDestination' && c.offset < invoke));
  assert.ok(action.binary.some((b) => b.left === '$Element.Current.Name' && b.operator === 'Cnotin' && b.right === '$ExpectedNames'));
  const calls = astFn('Invoke-CandidateSmoke').calls.filter((c) => c.name === 'Invoke-SmokePattern' && c.text.includes('$button'));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.text.includes('-PrintPreview $destination') && c.text.includes('-ExpectedNames')));
});
