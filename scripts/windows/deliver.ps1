#Requires -Version 5.1
[CmdletBinding(DefaultParameterSetName = 'Existing')]
param(
    [Parameter(Mandatory)][string]$OutputRoot,
    [Parameter(Mandatory, ParameterSetName = 'Build')][switch]$Build,
    [Parameter(Mandatory, ParameterSetName = 'Existing')][string]$PackagePath,
    [Parameter(Mandatory, ParameterSetName = 'Existing')][string]$ExpectedPackageSha256,
    [string]$SevenZip = '7z.exe',
    [string]$EvidenceDirectory
)
. (Join-Path $PSScriptRoot 'Delivery.Common.ps1')
$repository = Get-LocalPath (Join-Path $PSScriptRoot '../..')
$mode = $PSCmdlet.ParameterSetName
$OutputRoot = Get-LocalPath $OutputRoot
Assert-SeparatePaths $OutputRoot $repository
if (!$EvidenceDirectory) { $EvidenceDirectory = Join-Path $repository ('.audit/delivery-' + [guid]::NewGuid().ToString('N')) }
$evidence = New-EmptyDirectory $EvidenceDirectory
$null = [IO.Directory]::CreateDirectory($OutputRoot)
$staging = New-EmptyDirectory (Join-Path $OutputRoot ([guid]::NewGuid().ToString('N') + '.partial'))
$source = @{ status = 'unknown'; manifest = $null }
$sourceHead = $null
$sourceWorktreeDirty = $null
$validation = [ordered]@{
    checks = @{ status = 'not-run'; command = $null; exitCode = $null; sourceDigest = $null }
    build = @{ status = 'not-observed'; command = $null; exitCode = $null; sourceDigest = $null }
    browser = @{ status = 'not-run' }
    nativeAcceptance = @{ status = 'not-run' }
}
$result = @{ status = 'failed'; version = $null; build = $null; mode = $mode; evidence = $evidence; validation = $validation }

function Invoke-SourceJson([string[]]$Arguments, [string]$Name) {
    $stderrPath = Join-Path $evidence ($Name + '.stderr.log')
    $savedEncoding = [Console]::OutputEncoding
    $savedPreference = $ErrorActionPreference
    try {
        # PowerShell 5.1 otherwise decodes native UTF-8 JSON with the console codepage.
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $ErrorActionPreference = 'Continue'
        # Native children set the global automatic variable; a local sentinel would shadow it.
        $global:LASTEXITCODE = $null
        $jsonLines = @(& $sourceNode $sourceTool @Arguments 2> $stderrPath)
        $code = $global:LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedPreference
        [Console]::OutputEncoding = $savedEncoding
    }
    Write-AtomicJson (Join-Path $evidence ($Name + '.invocation.json')) @{ command = 'node source-manifest.mjs'; arguments = $Arguments; exitCode = $code }
    if ($null -eq $code -or $code -ne 0) { throw "Source capture/bind failed (exit $code); inspect $Name.stderr.log." }
    $json = $jsonLines -join [Environment]::NewLine
    try {
        if ([String]::IsNullOrWhiteSpace($json)) { throw 'Empty source-tool JSON.' }
        $value = $json | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $value -or $value -isnot [pscustomobject]) { throw 'Expected a source-tool object.' }
    } catch { throw "Invalid source-tool JSON for $Name." }
    Write-AtomicText (Join-Path $evidence ($Name + '.json')) ($json + [Environment]::NewLine)
    return $value
}

try {
    if ($mode -eq 'Build') {
        if (!$Build) { throw 'The Build parameter set requires -Build, not -Build:$false.' }
        $sourceNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
        $sourceTool = Join-Path $repository 'scripts/source-manifest.mjs'
        $beforePath = Join-Path $evidence 'source-before-checks.json'
        $afterChecksPath = Join-Path $evidence 'source-after-checks.json'
        $afterBuildPath = Join-Path $evidence 'source-after-build.json'
        $null = Invoke-SourceJson @('capture', $repository) 'source-before-checks'
        $identity = Get-ReleaseIdentity $repository
        $result.version = $identity.version; $result.build = $identity.build
        # Git is supplementary metadata only; the content manifest also covers untracked inputs.
        if (Get-Command git -CommandType Application -ErrorAction SilentlyContinue) {
            $head = & git -C $repository rev-parse HEAD 2> (Join-Path $evidence 'git-head.stderr.log')
            if ($LASTEXITCODE -eq 0) { $sourceHead = ($head -join '').Trim() }
            $dirty = @(& git -C $repository status --porcelain 2> (Join-Path $evidence 'git-status.stderr.log'))
            if ($LASTEXITCODE -eq 0) { $sourceWorktreeDirty = ($dirty.Count -gt 0) }
        }
        $temporary = New-EmptyDirectory (Join-Path $evidence 'build-temp')
        $target = New-EmptyDirectory (Join-Path $evidence 'target')
        $saved = @{ TEMP = $env:TEMP; TMP = $env:TMP; CARGO_TARGET_DIR = $env:CARGO_TARGET_DIR }
        Push-Location $repository
        try {
            $env:TEMP = $temporary; $env:TMP = $temporary; $env:CARGO_TARGET_DIR = $target
            & npm.cmd run check *> (Join-Path $evidence 'check.log')
            $checkExitCode = $LASTEXITCODE
            $validation.checks = @{ status = 'ran-unbound'; command = 'npm.cmd run check'; exitCode = $checkExitCode; sourceDigest = $null }
            if ($checkExitCode -ne 0) { $validation.checks.status = 'failed'; throw 'Frontend checks failed.' }
            $null = Invoke-SourceJson @('capture', $repository) 'source-after-checks'
            $checksBinding = Invoke-SourceJson @('bind', 'Build', $beforePath, $afterChecksPath) 'source-checks-binding'
            $validation.checks.status = 'passed'; $validation.checks.sourceDigest = $checksBinding.manifest.digest
            & npm.cmd run tauri -- build --bundles nsis *> (Join-Path $evidence 'build.log')
            $buildExitCode = $LASTEXITCODE
            $validation.build = @{ status = 'ran-unbound'; command = 'npm.cmd run tauri -- build --bundles nsis'; exitCode = $buildExitCode; sourceDigest = $null }
            if ($buildExitCode -ne 0) { $validation.build.status = 'failed'; throw 'NSIS build failed; inspect build.log.' }
            $null = Invoke-SourceJson @('capture', $repository) 'source-after-build'
            $source = Invoke-SourceJson @('bind', 'Build', $beforePath, $afterChecksPath, $afterBuildPath) 'source-build-binding'
            $validation.build.status = 'passed'; $validation.build.sourceDigest = $source.manifest.digest
        } finally {
            $env:TEMP = $saved.TEMP; $env:TMP = $saved.TMP; $env:CARGO_TARGET_DIR = $saved.CARGO_TARGET_DIR
            Pop-Location
        }
        $PackagePath = Join-Path $target ('release/bundle/nsis/' + $identity.packageName)
        $ExpectedPackageSha256 = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash
        $provenanceNotice = 'Source inputs were observed stable across this invocation checks and build. This is not a reproducible-build or native-acceptance guarantee.'
    } else {
        # Importing old bytes must not inherit today's version/build label, HEAD or check logs.
        $PackagePath = Get-LocalPath $PackagePath
        $packageName = [IO.Path]::GetFileName($PackagePath)
        if ($packageName -cnotmatch '^MDPlus_(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)_x64-setup\.exe$') { throw 'Invalid existing package filename.' }
        $identity = [pscustomobject]@{ version = $Matches[1]; build = $null; packageName = $packageName }
        $result.version = $identity.version
        $provenanceNotice = 'Existing package: original source/build identity is UNKNOWN. Checks and compilation were not run for this import. Current working-tree evidence does not validate these bytes.'
    }
    $PackagePath = Get-LocalPath $PackagePath
    if ([IO.Path]::GetFileName($PackagePath) -cne $identity.packageName) { throw 'Package filename does not match the expected identity.' }
    $buildLabel = if ($null -eq $identity.build) { 'unknown' } else { $identity.build }
    $readme = @(
        "MDPlus $($identity.version) / build: $buildLabel",
        $provenanceNotice,
        'Only this setup package is current. Archive packages are for rollback.',
        'Delivery does not install. Browser and native acceptance are not performed by this script.',
        'See docs/ops/windows-delivery.md before installing.'
    ) -join [Environment]::NewLine
    Write-AtomicText (Join-Path $staging 'README.txt') ($readme + [Environment]::NewLine)
    Assert-NormalIntegrity (Join-Path $staging 'README.txt') $evidence
    $exported = Join-Path $staging $identity.packageName
    Copy-VerifiedFile $PackagePath $exported $ExpectedPackageSha256
    Assert-NormalIntegrity $exported $evidence
    $payloadDirectory = New-EmptyDirectory (Join-Path $evidence 'payload')
    & $SevenZip e -y "-o$payloadDirectory" $exported mdplus.exe *> (Join-Path $evidence 'extract.log')
    $result.extractExitCode = $LASTEXITCODE
    if ($result.extractExitCode -ne 0) { throw 'Cannot extract the actual packaged executable.' }
    $payload = Get-Item -LiteralPath (Get-LocalPath (Join-Path $payloadDirectory 'mdplus.exe'))
    if ($payload.VersionInfo.ProductVersion -cne $identity.version) { throw 'Packaged executable version mismatch.' }
    $manifest = [ordered]@{
        schema = 1; version = $identity.version; build = $identity.build; createdAt = (Get-Date -Format o)
        mode = $mode; sourceHead = $sourceHead; sourceWorktreeDirty = $sourceWorktreeDirty
        source = $source; validation = $validation
        package = @{ name = $identity.packageName; sha256 = $ExpectedPackageSha256.ToUpperInvariant(); bytes = (Get-Item -LiteralPath $exported).Length }
        payload = @{ sha256 = (Get-FileHash -LiteralPath $payload.FullName -Algorithm SHA256).Hash; bytes = $payload.Length }
    }
    Write-AtomicJson (Join-Path $staging 'manifest.json') $manifest
    Write-AtomicText (Join-Path $staging 'SHA256SUMS') ($manifest.package.sha256 + '  ' + $identity.packageName + [Environment]::NewLine)
    $result.current = Publish-Delivery $staging $OutputRoot
    $result.status = 'passed'
} catch { $result.error = $_.Exception.Message; throw }
finally {
    $result.sourceStatus = $source.status
    $result.sourceDigest = if ($null -ne $source.manifest) { $source.manifest.digest } else { $null }
    $result.completedAt = Get-Date -Format o
    Write-AtomicJson (Join-Path $evidence 'result.json') $result
}
$result | ConvertTo-Json -Depth 12
