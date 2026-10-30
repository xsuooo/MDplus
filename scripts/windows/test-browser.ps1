#Requires -Version 5.1
param(
    [Parameter(Mandatory)][string]$Browser,
    [string[]]$Cases = @('typography-defaults', 'typography-independent-fonts', 'typography-persistence', 'typography-global-ui', 'typography-shortcut-fonts'),
    [string]$EvidenceDirectory
)
. (Join-Path $PSScriptRoot 'Delivery.Common.ps1')
$repository = Get-LocalPath (Join-Path $PSScriptRoot '../..')
if (!$EvidenceDirectory) { $EvidenceDirectory = Join-Path $repository ('.audit/browser-' + [guid]::NewGuid().ToString('N')) }
$evidence = New-EmptyDirectory $EvidenceDirectory
$Browser = (Get-Command $Browser -CommandType Application).Source
if ([IO.Path]::GetExtension($Browser) -ine '.exe') { throw 'Pass the native agent-browser Windows EXE, not a cmd wrapper.' }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$session = 'mdplus-' + [guid]::NewGuid().ToString('N')
$server = $null; $opened = $false; $failure = $null
$results = [Collections.Generic.List[object]]::new()
Write-AtomicJson (Join-Path $evidence 'session.json') @{ session = $session; port = $port }
function Invoke-Browser([string[]]$Arguments) {
    $id = [guid]::NewGuid().ToString('N')
    $stdout = Join-Path $evidence ($id + '.out')
    $stderr = Join-Path $evidence ($id + '.err')
    # Do not pipe a daemon-launching CLI: its child can keep the pipe open forever.
    $command = Start-Process -FilePath $Browser -WindowStyle Hidden -PassThru `
        -ArgumentList (@('--session', $session) + $Arguments) -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    try {
        if (!$command.WaitForExit(45000)) {
            $command | Stop-Process
            throw 'Browser command timed out; only the test-owned CLI process was stopped.'
        }
        $command.Refresh()
        if ($command.ExitCode -ne 0) { throw "Browser command failed; inspect $stderr" }
        $stream = [IO.File]::Open($stdout, 'Open', 'Read', 'ReadWrite')
        $reader = [IO.StreamReader]::new($stream)
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $command.Dispose() }
}
try {
    $server = Start-Process -FilePath (Get-Command node.exe).Source -WorkingDirectory $repository -WindowStyle Hidden -PassThru `
        -ArgumentList @('node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', $port, '--strictPort') `
        -RedirectStandardOutput (Join-Path $evidence 'vite.log') -RedirectStandardError (Join-Path $evidence 'vite-error.log')
    Write-AtomicJson (Join-Path $evidence 'server.json') @{ pid = $server.Id; port = $port }
    $end = (Get-Date).AddSeconds(30)
    do {
        if ($server.HasExited) { throw 'Test server exited.' }
        try { $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/tests/browser/index.html" -TimeoutSec 2; break }
        catch { if ((Get-Date) -gt $end) { throw }; Start-Sleep -Milliseconds 250 }
    } while ($true)
    if ($Cases -contains 'all') {
        $Cases = @('editor-sync')
        foreach ($entry in @(@('export.ts','exportCases'), @('media.tsx','mediaCases'), @('typography.tsx','typographyCases'), @('continuity.tsx','continuityCases'), @('recovery.tsx','recoveryCases'), @('appearance.tsx','appearanceCases'), @('markdownRoundtrip.ts','markdownCases'), @('mermaidCommit.ts','mermaidCases'), @('appSafety.tsx','safetyCases'))) {
            $source = Get-Content -LiteralPath (Join-Path $repository "tests/browser/$($entry[0])") -Raw
            $array = [regex]::Match($source, "(?s)export const $($entry[1]) = \[(.*?)\]").Groups[1].Value
            $found = @([regex]::Matches($array, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
            if (!$found.Count) { throw "Could not discover $($entry[1])" }
            $Cases += $found
        }
    }
    foreach ($case in $Cases) {
        if ($case -notmatch '^[a-z0-9-]+$') { throw 'Invalid browser case name.' }
        $url = "http://127.0.0.1:$port/tests/browser/index.html?case=$case"
        $opened = $true
        $null = Invoke-Browser @('open', $url)
        $end = (Get-Date).AddSeconds(60)
        do {
            Start-Sleep -Milliseconds 400
            $script = '({url:location.href,status:document.querySelector("#regression-result")?.dataset.status,detail:document.querySelector("#regression-result")?.textContent})'
            $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
            $raw = Invoke-Browser @('eval', "eval(atob('$encoded'))", '--json')
            $report = ($raw | ConvertFrom-Json).data.result
        } while ($report.status -notin @('passed', 'failed') -and (Get-Date) -lt $end)
        if ($report.url -ne $url) { throw 'Result URL mismatch.' }
        $results.Add(@{ case = $case; status = $report.status; detail = $report.detail })
        Write-Host "$case : $($report.status)"
    }
} catch { $failure = $_.Exception.Message; throw }
finally {
    try { if ($opened) { $null = Invoke-Browser @('close') } }
    finally {
        if ($server -and !$server.HasExited) { $server | Stop-Process }
        Write-AtomicJson (Join-Path $evidence 'results.json') @{ cases = $Cases; results = $results.ToArray(); error = $failure; nativeIPC = 'browser mock'; completedAt = (Get-Date -Format o) }
    }
}
if ($results.Count -ne $Cases.Count -or @($results | Where-Object { $_.status -ne 'passed' }).Count) { throw 'Browser regression failed or incomplete.' }
Write-Host "$($results.Count) browser cases passed (native IPC mocked)."
