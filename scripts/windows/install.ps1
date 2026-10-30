#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DeliveryDirectory,
    [Parameter(Mandatory)][string]$InstallDirectory,
    [Parameter(Mandatory)][string]$BackupDirectory,
    [Parameter(Mandatory)][string]$RollbackPackage,
    [Parameter(Mandatory)][string]$RollbackSha256,
    [Parameter(Mandatory)][string]$AcceptanceReport,
    [string]$SevenZip = '7z.exe',
    [switch]$Install
)
. (Join-Path $PSScriptRoot 'Delivery.Common.ps1')
if (!$Install) { throw 'No installation performed. Review acceptance and explicitly pass -Install.' }
$repository = Get-LocalPath (Join-Path $PSScriptRoot '../..')
$DeliveryDirectory = Get-LocalPath $DeliveryDirectory
$InstallDirectory = Get-LocalPath $InstallDirectory
$BackupDirectory = Get-LocalPath $BackupDirectory
$RollbackPackage = Get-LocalPath $RollbackPackage
Assert-SeparatePaths $DeliveryDirectory $repository
Assert-SeparatePaths $InstallDirectory $repository
Assert-SeparatePaths $BackupDirectory $repository
Assert-SeparatePaths $BackupDirectory $DeliveryDirectory
Assert-SeparatePaths $BackupDirectory $RollbackPackage
Assert-SeparatePaths $InstallDirectory $DeliveryDirectory
$candidate = Read-Delivery $DeliveryDirectory
$package = Join-Path $DeliveryDirectory $candidate.package.name
$acceptance = Get-Content -LiteralPath (Get-LocalPath $AcceptanceReport) -Raw | ConvertFrom-Json
if ($acceptance.status -ne 'approved' -or $acceptance.packageSha256 -ne $candidate.package.sha256 -or !$acceptance.report) {
    throw 'Acceptance must explicitly approve this exact package and identify the report (including untested/degraded items).'
}
$reportPath = Get-LocalPath $acceptance.report
Assert-Hash $reportPath $acceptance.reportSha256
$installedExe = Join-Path $InstallDirectory 'mdplus.exe'
if (!(Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw 'Upgrade only: select the existing MDPlus installation.' }
$registration = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MDPlus'
if ((Get-LocalPath $registration.InstallLocation) -ine $InstallDirectory) { throw 'Install directory differs from the registered per-user installation.' }
$roots = @{ installation = $InstallDirectory; roaming = Join-Path $env:APPDATA 'com.mdplus.desktop'; local = Join-Path $env:LOCALAPPDATA 'com.mdplus.desktop' }
$roots.roaming = Get-LocalPath $roots.roaming; $roots.local = Get-LocalPath $roots.local
Assert-SeparatePaths $InstallDirectory $roots.roaming
Assert-SeparatePaths $InstallDirectory $roots.local
Assert-MDPlusIdle $InstallDirectory
$snapshot = Backup-VerifiedTrees $roots $BackupDirectory $RollbackPackage $RollbackSha256
$result = @{ status = 'failed'; version = $candidate.version; build = $candidate.build; packageSha256 = $candidate.package.sha256; startedAt = (Get-Date -Format o) }
try {
    Write-AtomicJson (Join-Path $BackupDirectory 'registration.json') ($registration | Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation, UninstallString)
    Copy-VerifiedFile (Get-LocalPath $AcceptanceReport) (Join-Path $BackupDirectory 'acceptance.json') (Get-FileHash -LiteralPath $AcceptanceReport -Algorithm SHA256).Hash
    Copy-VerifiedFile $reportPath (Join-Path $BackupDirectory 'acceptance-report.md') $acceptance.reportSha256
    Assert-NormalIntegrity $package $BackupDirectory
    Assert-NormalIntegrity (Join-Path $BackupDirectory 'rollback-setup.exe') $BackupDirectory
    $rollbackPayloadDirectory = New-EmptyDirectory (Join-Path $BackupDirectory 'rollback-payload')
    & $SevenZip e -y "-o$rollbackPayloadDirectory" (Join-Path $BackupDirectory 'rollback-setup.exe') mdplus.exe *> (Join-Path $BackupDirectory 'rollback-extract.log')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify rollback payload.' }
    Assert-Hash (Join-Path $rollbackPayloadDirectory 'mdplus.exe') (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash
    Assert-MDPlusIdle $InstallDirectory
    Assert-TreeState $roots $snapshot
    Assert-Hash $package $candidate.package.sha256
    Assert-Hash (Join-Path $BackupDirectory 'rollback-setup.exe') $RollbackSha256
    # NSIS /D is deliberately last and unquoted; the rest of the command line is the path.
    $process = Start-Process -FilePath $package -ArgumentList @('/S', '/UPDATE', "/D=$InstallDirectory") -WindowStyle Hidden -PassThru
    $result.pid = $process.Id
    if (!$process.WaitForExit(180000)) { throw 'Installer timeout. Process left intact; do not retry until it has exited and evidence is reviewed.' }
    $process.Refresh(); $result.exitCode = $process.ExitCode
    if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode). No automatic retry/rollback." }
    Assert-Hash $installedExe $candidate.payload.sha256
    $registeredVersion = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MDPlus').DisplayVersion
    if ($registeredVersion -cne $candidate.version -or (Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion -cne $candidate.version) {
        throw 'Installed version does not match the candidate.'
    }
    Assert-TreeState @{ roaming = $roots.roaming; local = $roots.local } ([ordered]@{ local = $snapshot.local; roaming = $snapshot.roaming })
    $result.status = 'passed'
    $result.profileUnchangedBeforeLaunch = $true
} catch { $result.error = $_.Exception.Message; throw }
finally {
    $result.completedAt = Get-Date -Format o
    Write-AtomicJson (Join-Path $BackupDirectory 'install-result.json') $result
}
$result | ConvertTo-Json
