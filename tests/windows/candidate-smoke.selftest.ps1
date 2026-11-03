[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'candidate-smoke.ps1'
if (Test-Path -LiteralPath $EvidenceDirectory) { throw 'Use a new self-test evidence directory.' }
$null = [IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($EvidenceDirectory))
$checks = [Collections.Generic.List[object]]::new()
function Check([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:checks.Add(@{name=$Name;status='passed'}) }
    catch { $script:checks.Add(@{name=$Name;status='failed';error=$_.Exception.Message}) }
}
function Must-Reject([scriptblock]$Body) {
    $rejected = $false
    try { & $Body } catch { $rejected = $true }
    if (!$rejected) { throw 'Expected rejection did not occur.' }
}
Check 'script exists before any automation is possible' {
    if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw 'candidate-smoke.ps1 is not implemented yet.' }
}
if (Test-Path -LiteralPath $source -PathType Leaf) {
    $tokens=$null; $errors=$null
    $ast = [Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
    Check 'PowerShell parses without errors' { if ($errors.Count) { throw ($errors | Out-String) } }
    $text = [IO.File]::ReadAllText($source)
    $functions = @{}
    foreach ($item in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
        $functions[$item.Name] = $item
    }
    # Load only these pure validators. Never dot-source or invoke the automation body.
    foreach ($name in @('Assert-SmokeHost','Assert-SmokeContext','Assert-SmokeHash','Assert-SmokeIdentity','Assert-SmokeInside')) {
        if (!$functions.ContainsKey($name)) { throw "Missing pure validator $name" }
        $body = $functions[$name].Extent.Text
        if ($body -match 'Process\]::Start|Start-Process|Add-Type|Invoke-Expression|\.Invoke\(|\.SetValue\(|\.CloseMainWindow\(') {
            throw "Validator is not pure: $name"
        }
        . ([scriptblock]::Create($body))
    }
    $hash = ('A' * 64)
    function Context {
        return [pscustomobject]@{
            Machine='SANDBOX'; HostComputerName='ORIGIN-HOST'; User='WDAGUtilityAccount';
            Manufacturer='Microsoft Corporation'; Model='Virtual Machine';
            LocalAppData='C:\Users\WDAGUtilityAccount\AppData\Local';
            RoamingAppData='C:\Users\WDAGUtilityAccount\AppData\Roaming';
            InputRoot='C:\MDPlusCandidateInput'; OutputRoot='C:\MDPlusCandidateResults';
            RunId='guard-fixture'; ExpectedExeSha256=$hash;
            Sentinel=[pscustomobject]@{schema=1;purpose='mdplus-candidate-smoke/v1';hostComputerName='ORIGIN-HOST';runId='guard-fixture';candidateSha256=$hash}
        }
    }
    Check 'valid isolated context is accepted by pure validator' { Assert-SmokeContext (Context) }
    Check 'host computer is rejected' { $c=Context; $c.Machine=$c.HostComputerName; Must-Reject { Assert-SmokeContext $c } }
    Check 'non-sandbox account is rejected' { $c=Context; $c.User='ordinary-user'; Must-Reject { Assert-SmokeContext $c } }
    Check 'non-VM model is rejected' { $c=Context; $c.Model='Desktop'; Must-Reject { Assert-SmokeContext $c } }
    Check 'host profile path is rejected' { $c=Context; $c.LocalAppData='D:\UserProfile'; Must-Reject { Assert-SmokeContext $c } }
    Check 'sentinel mismatch is rejected' { $c=Context; $c.Sentinel.runId='different'; Must-Reject { Assert-SmokeContext $c } }
    Check 'output root cannot be redirected' { $c=Context; $c.OutputRoot='C:\Users'; Must-Reject { Assert-SmokeContext $c } }
    Check 'path prefix is not a directory boundary' { Must-Reject { Assert-SmokeInside 'C:\MDPlusCandidateWork-escape\a' 'C:\MDPlusCandidateWork' } }
    Check 'candidate byte mismatch is rejected' {
        $file=Join-Path $EvidenceDirectory 'not-an-executable.fixture'
        [IO.File]::WriteAllText($file,'synthetic hash input')
        $original=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        Assert-SmokeHash $original $original
        [IO.File]::AppendAllText($file,'changed')
        Must-Reject { Assert-SmokeHash (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash $original }
    }
    $owned=[pscustomobject]@{Id=42;StartTicks=100;Path='C:\MDPlusCandidateWork\guard-fixture\bin\mdplus.exe';Exited=$false}
    Check 'owned process stamp is accepted' { Assert-SmokeIdentity $owned $owned }
    Check 'external PID is rejected' {
        $actual=[pscustomobject]@{Id=43;StartTicks=100;Path=$owned.Path;Exited=$false}
        Must-Reject { Assert-SmokeIdentity $owned $actual }
    }
    Check 'reused PID is rejected' {
        $actual=[pscustomobject]@{Id=42;StartTicks=101;Path=$owned.Path;Exited=$false}
        Must-Reject { Assert-SmokeIdentity $owned $actual }
    }
    Check 'different executable cannot be controlled' {
        $actual=[pscustomobject]@{Id=42;StartTicks=100;Path='C:\Windows\not-the-candidate.exe';Exited=$false}
        Must-Reject { Assert-SmokeIdentity $owned $actual }
    }
    Check 'no install kill coordinates registry or global environment mutation' {
        $forbidden='(?i)Stop-Process|taskkill|Set-ExecutionPolicy|WindowsSandbox\.exe|SetCursorPos|mouse_event|SendInput|SendWait|\.Kill\(|\.Terminate\(|SetEnvironmentVariable|CreateSubKey|HKLM:|HKCU:|\$env:\w+\s*='
        if ($text -match $forbidden) { throw "Forbidden operation: $($Matches[0])" }
    }
    Check 'all UIA mutation and close helpers verify ownership' {
        foreach ($name in @('Invoke-SmokePattern','Close-SmokeCandidate')) {
            $body=$functions[$name].Extent.Text
            if ($body -notmatch 'Assert-SmokeElement|Get-SmokeOwnedProcess') { throw "Unguarded helper: $name" }
        }
        $start=$functions['Start-SmokeCandidate'].Extent.Text
        if ($start.IndexOf('Assert-SmokeHash') -gt $start.IndexOf('[Diagnostics.Process]::Start')) { throw 'Hash verification is too late.' }
        $main=$functions['Invoke-CandidateSmoke'].Extent.Text
        if ($main.IndexOf('Assert-SmokeHost') -gt $main.IndexOf('Get-Content')) { throw 'Host rejection is too late.' }
    }
    Check 'actual entry point rejects this host before fixtures or process start' {
        $engine=(Get-Process -Id $PID).Path
        $output=& $engine -NoProfile -NonInteractive -File $source -HostComputerName ([Environment]::MachineName) -ExpectedExeSha256 $hash -RunId 'host-refusal-selftest' 2>&1
        $code=$LASTEXITCODE
        [IO.File]::WriteAllText((Join-Path $EvidenceDirectory 'host-refusal.txt'),($output | Out-String))
        if ($code -ne 2 -or ($output | Out-String) -notmatch 'REFUSED_HOST') { throw "Unexpected host refusal result: $code" }
    }
}
$failed=@($checks | Where-Object {$_.status -eq 'failed'}).Count
$result=@{status=$(if($failed){'failed'}else{'passed'});checks=@($checks.ToArray());failed=$failed;
    scope='static and isolated validators only; no candidate or Sandbox started';at=(Get-Date -Format o)}
[IO.File]::WriteAllText((Join-Path $EvidenceDirectory 'selftest.json'),($result | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Depth 8
if ($failed) { exit 1 }
