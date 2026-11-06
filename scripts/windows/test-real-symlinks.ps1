#Requires -Version 5.1
[CmdletBinding()]
param([string]$EvidenceDirectory)

$previousErrorPreference = $ErrorActionPreference
. (Join-Path $PSScriptRoot 'Delivery.Common.ps1')
$repository = Get-LocalPath (Join-Path $PSScriptRoot '../..')
if (!(Test-Path -LiteralPath (Join-Path $repository 'src-tauri/Cargo.toml') -PathType Leaf)) {
    throw 'The project Cargo manifest was not found.'
}
if (!$EvidenceDirectory) {
    $EvidenceDirectory = Join-Path $repository ('.audit/real-symlinks-' + [guid]::NewGuid().ToString('N'))
}
$EvidenceDirectory = Get-LocalPath $EvidenceDirectory
if (!(Test-InDirectory $EvidenceDirectory $repository) -or $EvidenceDirectory -eq $repository) {
    throw 'Test evidence must be in a new directory inside this project.'
}
$evidence = New-EmptyDirectory $EvidenceDirectory
$testTemp = New-EmptyDirectory (Join-Path $evidence 'temp')
$testLog = Join-Path $evidence 'test.log'
$buildLog = Join-Path $evidence 'build.jsonl'
$resultPath = Join-Path $evidence 'result.json'
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$nativePreferenceVariable = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
$hasNativePreference = $null -ne $nativePreferenceVariable
$previousNativePreference = if ($hasNativePreference) { $nativePreferenceVariable.Value } else { $null }
$locationPushed = $false
$exitCode = 1
$artifact = $null
$result = [ordered]@{
    scope = 'three real Windows file symlink unit regressions'
    project = $repository
    testTemp = $testTemp
    buildExitCode = $null
    sourceBinary = $null
    executedBinary = $null
    sourceSha256 = $null
    executedSha256 = $null
    copied = $false
    sourceLowOrUntrusted = $null
    executedLowOrUntrusted = $null
    testExecuted = $false
    testExitCode = $null
    passed = $null
    failed = $null
    ignored = $null
    status = 'failed'
    error = $null
}

function Write-TestLog([string]$Message) {
    Write-Output $Message
    Add-Content -LiteralPath $testLog -Value $Message -Encoding UTF8 -ErrorAction Stop
}

function Test-LowOrUntrustedIntegrity([string]$Path) {
    # Like Delivery.Common's Assert-NormalIntegrity, inspect saved SDDL only.
    # Mandatory label SIDs/aliases are independent of the Windows UI language.
    $inspection = Join-Path $evidence ('integrity-' + [guid]::NewGuid().ToString('N') + '.txt')
    & icacls.exe $Path /save $inspection /q | Out-Null
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $inspection -PathType Leaf)) {
        throw "Cannot inspect the integrity label: $Path"
    }
    $sddl = [IO.File]::ReadAllText($inspection, [Text.Encoding]::Unicode)
    return $sddl -match '\(ML;[^)]*;;;(LW|UN|S-1-16-(0|4096))\)'
}

try {
    Set-Content -LiteralPath $testLog -Value 'Real Windows file symlink unit regressions' -Encoding UTF8
    Get-Command cargo -CommandType Application -ErrorAction Stop | Out-Null
    $env:TEMP = $testTemp
    $env:TMP = $testTemp
    if ($hasNativePreference) { $PSNativeCommandUseErrorActionPreference = $false }
    Push-Location -LiteralPath $repository
    $locationPushed = $true

    Write-TestLog 'Build: cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --no-run --message-format=json'
    # Windows PowerShell 5.1 turns native stderr into error records. Preserve
    # native exit codes instead of treating normal Cargo progress as a failure.
    $ErrorActionPreference = 'Continue'
    cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --no-run --message-format=json 2>&1 | ForEach-Object -Process {
        $line = $_.ToString()
        Add-Content -LiteralPath $buildLog -Value $line -Encoding UTF8 -ErrorAction Stop
        $record = $null
        try { $record = $line | ConvertFrom-Json -ErrorAction Stop } catch { }
        if ($null -eq $record) {
            Write-TestLog $line
        } elseif ($record.reason -eq 'compiler-message') {
            Write-TestLog $record.message.rendered
        } elseif ($record.reason -eq 'compiler-artifact' -and $record.profile.test -and $record.executable) {
            $expectedSource = [IO.Path]::GetFullPath((Join-Path $repository 'src-tauri/src/lib.rs'))
            if ([IO.Path]::GetFullPath($record.target.src_path).Equals($expectedSource, [StringComparison]::OrdinalIgnoreCase)) {
                $artifact = $record
            }
        }
    } -ErrorAction Stop
    $result.buildExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($result.buildExitCode -ne 0) {
        $exitCode = $result.buildExitCode
        throw "Cargo compilation failed with exit code $exitCode."
    }
    if ($null -eq $artifact) { throw 'Cargo did not report the latest library test executable.' }

    $source = Get-LocalPath $artifact.executable
    if (!(Test-InDirectory $source $repository)) { throw 'The compiled test executable must be inside this project.' }
    $result.sourceBinary = $source
    $result.sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $result.sourceLowOrUntrusted = Test-LowOrUntrustedIntegrity $source
    $executed = $source

    if ($result.sourceLowOrUntrusted) {
        # Fresh bytes inherit the existing destination's security. Never alter
        # the source/destination labels, ACLs, process token, or system settings.
        $backup = Get-LocalPath (Join-Path $repository '_backup')
        if (!(Test-Path -LiteralPath $backup)) { $null = [IO.Directory]::CreateDirectory($backup) }
        if (!(Test-Path -LiteralPath $backup -PathType Container) -or (Test-LowOrUntrustedIntegrity $backup)) {
            throw 'The project _backup directory is Low/untrusted or not an ordinary directory; no security settings were changed.'
        }
        $staging = New-EmptyDirectory (Join-Path $backup ('real-symlinks-' + [guid]::NewGuid().ToString('N')))
        if (Test-LowOrUntrustedIntegrity $staging) {
            throw 'The new staging directory inherited Low/untrusted integrity; no security settings were changed.'
        }
        $executed = Join-Path $staging ([IO.Path]::GetFileName($source))
        Copy-VerifiedFile $source $executed $result.sourceSha256
        $result.copied = $true
    }

    $result.executedBinary = $executed
    $result.executedSha256 = (Get-FileHash -LiteralPath $executed -Algorithm SHA256).Hash
    if ($result.sourceSha256 -ne $result.executedSha256 -or
        $result.sourceSha256 -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) {
        throw 'The executable bytes changed or the copied executable differs from the original.'
    }
    $result.executedLowOrUntrusted = Test-LowOrUntrustedIntegrity $executed
    if ($result.executedLowOrUntrusted) {
        throw 'The test executable is still Low/untrusted; no security settings were changed.'
    }
    Write-TestLog "Original executable: $source"
    Write-TestLog "Executed executable: $executed"
    Write-TestLog ('Matching SHA256: ' + $result.sourceSha256)
    Write-TestLog 'Test arguments: review_p2_ --ignored --nocapture'

    $output = [Collections.Generic.List[string]]::new()
    $result.testExecuted = $true
    $ErrorActionPreference = 'Continue'
    & $executed review_p2_ --ignored --nocapture 2>&1 | ForEach-Object -Process {
        $line = $_.ToString()
        $output.Add($line)
        Write-TestLog $line
    } -ErrorAction Stop
    $exitCode = $LASTEXITCODE
    $result.testExitCode = $exitCode
    $ErrorActionPreference = 'Stop'

    $summaries = [regex]::Matches(($output -join [Environment]::NewLine), '(?m)^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;')
    if ($summaries.Count -ne 1) { throw 'The native test executable did not emit exactly one test result.' }
    $summary = $summaries[0]
    $result.passed = [int]$summary.Groups[2].Value
    $result.failed = [int]$summary.Groups[3].Value
    $result.ignored = [int]$summary.Groups[4].Value
    if ($exitCode -ne 0 -or $summary.Groups[1].Value -cne 'ok' -or
        $result.passed -ne 3 -or $result.failed -ne 0 -or $result.ignored -ne 0) {
        throw 'Real symlink regression coverage requires exactly 3 passed, 0 failed, and 0 ignored with native exit code 0.'
    }
    $result.status = 'passed'
} catch {
    if ($exitCode -eq 0) { $exitCode = 1 }
    $result.error = $_.Exception.Message
    Write-Error -Message $result.error -ErrorAction Continue
    if (Test-Path -LiteralPath $testLog) {
        Add-Content -LiteralPath $testLog -Value ('Runner error: ' + $result.error) -Encoding UTF8
    }
} finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    if ($hasNativePreference) { $PSNativeCommandUseErrorActionPreference = $previousNativePreference }
    if ($locationPushed) { Pop-Location }
    try {
        $ErrorActionPreference = 'Stop'
        Write-AtomicJson $resultPath $result
    } catch {
        if ($exitCode -eq 0) { $exitCode = 1 }
        Write-Error -Message ('Could not persist real symlink test results: ' + $_.Exception.Message) -ErrorAction Continue
    } finally {
        $ErrorActionPreference = $previousErrorPreference
    }
}

Write-Output "Test log: $testLog"
Write-Output "Build log: $buildLog"
Write-Output "Results: $resultPath"
exit $exitCode
