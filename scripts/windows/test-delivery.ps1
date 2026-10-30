#Requires -Version 5.1
param([string]$EvidenceDirectory)
. (Join-Path $PSScriptRoot 'Delivery.Common.ps1')
$repository = Get-LocalPath (Join-Path $PSScriptRoot '../..')
if (!$EvidenceDirectory) { $EvidenceDirectory = Join-Path $repository ('.audit/delivery-tests-' + [guid]::NewGuid().ToString('N')) }
$evidence = New-EmptyDirectory $EvidenceDirectory
$unicodeName = ([string][char]0x4E2D) + [char]0x6587 + ' space'
$root = New-EmptyDirectory (Join-Path $evidence $unicodeName)
$results = [Collections.Generic.List[object]]::new()
function Test-Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; $results.Add(@{ name = $Name; status = 'passed' }); Write-Host "PASS $Name" }
    catch { $results.Add(@{ name = $Name; status = 'failed'; error = $_.Exception.Message }); Write-Host "FAIL $Name : $_" }
}
function Assert-True($Value, [string]$Message) { if (!$Value) { throw $Message } }
function Assert-Throws([scriptblock]$Body, [string]$Message) {
    $threw = $false
    try { & $Body | Out-Null } catch { $threw = $true }
    Assert-True $threw $Message
}
function New-FixtureDelivery([string]$Path, [string]$Version, [string]$Content) {
    $dir = New-EmptyDirectory $Path
    $name = "MDPlus_${Version}_x64-setup.exe"
    Write-AtomicText (Join-Path $dir $name) $Content
    $hash = (Get-FileHash -LiteralPath (Join-Path $dir $name) -Algorithm SHA256).Hash
    Write-AtomicText (Join-Path $dir 'README.txt') 'SYNTHETIC TEST. NOT AN INSTALLER.'
    Write-AtomicText (Join-Path $dir 'SHA256SUMS') "$hash  $name"
    Write-AtomicJson (Join-Path $dir 'manifest.json') @{ schema = 1; version = $Version; build = 'synthetic'; package = @{ name = $name; sha256 = $hash }; payload = @{ sha256 = $hash } }
    return $dir
}

Test-Case 'PowerShell scripts parse' {
    foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
        $tokens = $null; $errors = $null
        $null = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
        Assert-True ($errors.Count -eq 0) "Syntax errors in $($file.Name): $errors"
    }
}
Test-Case 'source versions agree' { $id = Get-ReleaseIdentity $repository; Assert-True (!!$id.build) 'Missing build' }
Test-Case 'version drift is refused' {
    $fixture = New-EmptyDirectory (Join-Path $root 'repo')
    $null = [IO.Directory]::CreateDirectory((Join-Path $fixture 'src-tauri'))
    $null = [IO.Directory]::CreateDirectory((Join-Path $fixture 'src/lib'))
    foreach ($file in @('package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src/lib/buildInfo.ts')) {
        Copy-VerifiedFile (Join-Path $repository $file) (Join-Path $fixture $file) (Get-FileHash -LiteralPath (Join-Path $repository $file)).Hash
    }
    $p = Join-Path $fixture 'package.json'
    [IO.File]::WriteAllText($p, '{"version":"9.9.9"}')
    Assert-Throws { Get-ReleaseIdentity $fixture } 'Version drift was accepted'
}
Test-Case 'atomic Unicode copy' {
    $script:source = Join-Path $root 'source.bin'; $script:destination = Join-Path $root 'copied.bin'
    Write-AtomicText $source 'synthetic bytes'
    $script:hash = (Get-FileHash -LiteralPath $source).Hash
    Copy-VerifiedFile $source $destination $hash
    Assert-Hash $destination $hash
    Assert-True (!(Test-Path -LiteralPath ($destination + '.partial'))) 'Partial not renamed'
}
Test-Case 'hash mismatch never publishes' {
    $bad = Join-Path $root 'bad.bin'
    Assert-Throws { Copy-VerifiedFile $source $bad ('0' * 64) } 'Bad hash was accepted'
    Assert-True (!(Test-Path -LiteralPath $bad)) 'Bad output was published'
    Assert-True (Test-Path -LiteralPath ($bad + '.partial')) 'Diagnostic partial lost'
}
Test-Case 'existing outputs and partials are not overwritten' {
    Assert-Throws { Copy-VerifiedFile $source $destination $hash } 'Duplicate copy succeeded'
    Assert-Throws { Copy-VerifiedFile $source (Join-Path $root 'bad.bin') $hash } 'Stale partial overwritten'
    Assert-Throws { Write-AtomicText $source 'overwrite' } 'Text overwritten'
    Assert-Hash $destination $hash
}
Test-Case 'unsafe paths refused' {
    foreach ($path in @('C:\', 'C:relative', '\\server\share', '.\relative')) {
        Assert-Throws { Get-LocalPath $path } "Unsafe path accepted: $path"
    }
    Assert-Throws { Assert-SeparatePaths $root (Join-Path $root 'child') } 'Nested paths accepted'
}
Test-Case 'junction traversal refused' {
    $target = New-EmptyDirectory (Join-Path $root 'junction-target')
    $link = Join-Path $root 'junction-link'
    $null = New-Item -ItemType Junction -Path $link -Target $target
    Assert-Throws { Get-LocalPath (Join-Path $link 'child') } 'Junction was followed'
}
Test-Case 'backup includes absent roots and empty directories' {
    $script:trees = @{ local = (New-EmptyDirectory (Join-Path $root 'profile')); roaming = (Join-Path $root 'absent-profile') }
    $null = New-EmptyDirectory (Join-Path $trees.local 'empty')
    Write-AtomicText (Join-Path $trees.local ($unicodeName + '.json')) '{"synthetic":true}'
    $script:backupPath = Join-Path $root 'backup'
    $script:snapshot = Backup-VerifiedTrees $trees $backupPath $source $hash
    Assert-TreeState $trees $snapshot
    Assert-True (Test-Path -LiteralPath (Join-Path $backupPath 'local/empty')) 'Empty directory lost'
    Assert-Hash (Join-Path $backupPath 'rollback-setup.exe') $hash
    Assert-True (!$snapshot.roaming.exists) 'Missing root not recorded'
}
Test-Case 'backup collision and overlap refused' {
    Assert-Throws { Backup-VerifiedTrees $trees $backupPath $source $hash } 'Backup overwritten'
    Assert-Throws { Backup-VerifiedTrees $trees (Join-Path $trees.local 'nested') $source $hash } 'Recursive backup accepted'
}
Test-Case 'locked profile blocks snapshot' {
    $file = Join-Path $trees.local ($unicodeName + '.json')
    $handle = [IO.File]::Open($file, 'Open', 'ReadWrite', 'None')
    try { Assert-Throws { Backup-VerifiedTrees $trees (Join-Path $root 'locked-backup') $source $hash } 'Locked data backed up' }
    finally { $handle.Dispose() }
    Assert-True (!(Test-Path -LiteralPath (Join-Path $root 'locked-backup'))) 'Incomplete backup published'
}
Test-Case 'file changes and newly appearing roots detected' {
    Write-AtomicText (Join-Path $trees.local 'new.txt') 'new'
    Assert-Throws { Assert-TreeState $trees $snapshot } 'Changed files not detected'
    $newState = Get-TreeState $trees
    $null = New-EmptyDirectory $trees.roaming
    Assert-Throws { Assert-TreeState $trees $newState } 'New root not detected'
}
Test-Case 'first publication and archive preserve old bytes' {
    $script:deliveryRoot = New-EmptyDirectory (Join-Path $root 'delivery')
    $first = New-FixtureDelivery (Join-Path $deliveryRoot 'first.partial') '1.0.0' 'old'
    $script:firstHash = (Read-Delivery $first).package.sha256
    $null = Publish-Delivery $first $deliveryRoot
    $second = New-FixtureDelivery (Join-Path $deliveryRoot 'second.partial') '1.0.1' 'new'
    $null = Publish-Delivery $second $deliveryRoot
    Assert-True ((Read-Delivery (Join-Path $deliveryRoot 'current')).version -eq '1.0.1') 'Wrong current'
    $archives = @(Get-ChildItem -LiteralPath (Join-Path $deliveryRoot 'archive') -Directory)
    Assert-True ($archives.Count -eq 1) 'Wrong archive count'
    Assert-True ((Read-Delivery $archives[0].FullName).package.sha256 -eq $firstHash) 'Archive bytes lost'
}
Test-Case 'duplicate publication is non-destructive' {
    $duplicate = New-FixtureDelivery (Join-Path $deliveryRoot 'duplicate.partial') '1.0.1' 'new'
    Assert-Throws { Publish-Delivery $duplicate $deliveryRoot } 'Duplicate was published'
    Assert-True ((Read-Delivery (Join-Path $deliveryRoot 'current')).version -eq '1.0.1') 'Current lost'
}
Test-Case 'corrupt candidate never displaces current' {
    $badCandidate = New-FixtureDelivery (Join-Path $deliveryRoot 'corrupt.partial') '1.0.2' 'candidate'
    [IO.File]::WriteAllText((Join-Path $badCandidate 'MDPlus_1.0.2_x64-setup.exe'), 'corrupt')
    Assert-Throws { Publish-Delivery $badCandidate $deliveryRoot } 'Corrupt candidate published'
    Assert-True ((Read-Delivery (Join-Path $deliveryRoot 'current')).version -eq '1.0.1') 'Current displaced'
}
Test-Case 'archive path conflict preserves current and candidate' {
    $otherRoot = New-EmptyDirectory (Join-Path $root 'blocked-archive')
    $first = New-FixtureDelivery (Join-Path $otherRoot 'first.partial') '1.0.0' 'first'
    $null = Publish-Delivery $first $otherRoot
    Write-AtomicText (Join-Path $otherRoot 'archive') 'not a directory'
    $next = New-FixtureDelivery (Join-Path $otherRoot 'next.partial') '1.0.1' 'next'
    Assert-Throws { Publish-Delivery $next $otherRoot } 'Conflicting archive ignored'
    Assert-True ((Read-Delivery (Join-Path $otherRoot 'current')).version -eq '1.0.0') 'Current lost'
    Assert-True ((Read-Delivery $next).version -eq '1.0.1') 'Candidate lost'
}
Test-Case 'unknown current contents block archiving' {
    Write-AtomicText (Join-Path $deliveryRoot 'current/user-note.md') 'keep me'
    $next = New-FixtureDelivery (Join-Path $deliveryRoot 'next.partial') '1.0.2' 'next'
    Assert-Throws { Publish-Delivery $next $deliveryRoot } 'Unknown files archived'
    Assert-True (Test-Path -LiteralPath (Join-Path $deliveryRoot 'current/user-note.md')) 'User file lost'
}
Test-Case 'installer requires explicit switch before reading paths' {
    Assert-Throws { & (Join-Path $PSScriptRoot 'install.ps1') -DeliveryDirectory 'not-a-path' -InstallDirectory 'not-a-path' -BackupDirectory 'not-a-path' -RollbackPackage 'not-a-path' -RollbackSha256 $hash -AcceptanceReport 'not-a-path' } 'Implicit installation allowed'
}
Write-AtomicJson (Join-Path $evidence 'results.json') @{ tests = $results.ToArray(); nativeInstallerExecuted = $false; completedAt = (Get-Date -Format o) }
if (@($results | Where-Object { $_.status -ne 'passed' }).Count) { throw "Delivery regression failed; see $evidence" }
Write-Host "$($results.Count) delivery checks passed. Synthetic files only; no host installation."
