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
$identity = Get-ReleaseIdentity $repository
$OutputRoot = Get-LocalPath $OutputRoot
Assert-SeparatePaths $OutputRoot $repository
if (!$EvidenceDirectory) { $EvidenceDirectory = Join-Path $repository ('.audit/delivery-' + [guid]::NewGuid().ToString('N')) }
$evidence = New-EmptyDirectory $EvidenceDirectory
$null = [IO.Directory]::CreateDirectory($OutputRoot)
$staging = New-EmptyDirectory (Join-Path $OutputRoot ([guid]::NewGuid().ToString('N') + '.partial'))
$result = @{ status = 'failed'; version = $identity.version; build = $identity.build; mode = $PSCmdlet.ParameterSetName; evidence = $evidence }
try {
    Write-AtomicText (Join-Path $staging 'README.txt') "MDPlus $($identity.version) / $($identity.build)`r`nOnly this setup package is current. Archive packages are for rollback.`r`nDelivery does not install. See docs/ops/windows-delivery.md before installing.`r`n"
    Assert-NormalIntegrity (Join-Path $staging 'README.txt') $evidence
    if ($Build) {
        $temporary = New-EmptyDirectory (Join-Path $evidence 'build-temp')
        $target = New-EmptyDirectory (Join-Path $evidence 'target')
        $saved = @{ TEMP = $env:TEMP; TMP = $env:TMP; CARGO_TARGET_DIR = $env:CARGO_TARGET_DIR }
        Push-Location $repository
        try {
            $env:TEMP = $temporary; $env:TMP = $temporary; $env:CARGO_TARGET_DIR = $target
            & npm.cmd run check *> (Join-Path $evidence 'check.log')
            if ($LASTEXITCODE -ne 0) { throw 'Frontend checks failed.' }
            & npm.cmd run tauri -- build --bundles nsis *> (Join-Path $evidence 'build.log')
            if ($LASTEXITCODE -ne 0) { throw 'NSIS build failed; inspect build.log.' }
        } finally {
            $env:TEMP = $saved.TEMP; $env:TMP = $saved.TMP; $env:CARGO_TARGET_DIR = $saved.CARGO_TARGET_DIR
            Pop-Location
        }
        $PackagePath = Join-Path $target ('release/bundle/nsis/' + $identity.packageName)
        $ExpectedPackageSha256 = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash
    }
    $PackagePath = Get-LocalPath $PackagePath
    if ([IO.Path]::GetFileName($PackagePath) -cne $identity.packageName) { throw 'Package filename does not match source version.' }
    $exported = Join-Path $staging $identity.packageName
    Copy-VerifiedFile $PackagePath $exported $ExpectedPackageSha256
    Assert-NormalIntegrity $exported $evidence
    $payloadDirectory = New-EmptyDirectory (Join-Path $evidence 'payload')
    & $SevenZip e -y "-o$payloadDirectory" $exported mdplus.exe *> (Join-Path $evidence 'extract.log')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the actual packaged executable.' }
    $payload = Get-Item -LiteralPath (Join-Path $payloadDirectory 'mdplus.exe')
    if ($payload.VersionInfo.ProductVersion -cne $identity.version) { throw 'Packaged executable version mismatch.' }
    $manifest = [ordered]@{
        schema = 1; version = $identity.version; build = $identity.build; createdAt = (Get-Date -Format o)
        sourceHead = (& git -C $repository rev-parse HEAD); mode = $PSCmdlet.ParameterSetName
        sourceWorktreeDirty = (@(& git -C $repository status --porcelain).Count -gt 0)
        package = @{ name = $identity.packageName; sha256 = $ExpectedPackageSha256.ToUpperInvariant(); bytes = (Get-Item -LiteralPath $exported).Length }
        payload = @{ sha256 = (Get-FileHash -LiteralPath $payload.FullName -Algorithm SHA256).Hash; bytes = $payload.Length }
    }
    Write-AtomicJson (Join-Path $staging 'manifest.json') $manifest
    Write-AtomicText (Join-Path $staging 'SHA256SUMS') ($manifest.package.sha256 + '  ' + $identity.packageName + "`r`n")
    $result.current = Publish-Delivery $staging $OutputRoot
    $result.status = 'passed'
} catch { $result.error = $_.Exception.Message; throw }
finally {
    $result.completedAt = Get-Date -Format o
    Write-AtomicJson (Join-Path $evidence 'result.json') $result
}
$result | ConvertTo-Json
