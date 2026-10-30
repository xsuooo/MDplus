Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-LocalPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '["\r\n]') { throw 'Use an absolute local Windows path.' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full.Length -le 3) { throw 'A drive root is not a safe target.' }
    $cursor = $full
    while ($cursor.Length -gt 3) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse points are not supported: $cursor"
            }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}

function Test-InDirectory([string]$Path, [string]$Directory) {
    return $Path.Equals($Directory, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($Directory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SeparatePaths([string]$First, [string]$Second) {
    if ((Test-InDirectory $First $Second) -or (Test-InDirectory $Second $First)) { throw 'Paths must not overlap.' }
}

function New-EmptyDirectory([string]$Path) {
    $Path = Get-LocalPath $Path
    if (Test-Path -LiteralPath $Path) { throw "Refusing to overwrite existing evidence: $Path" }
    $null = [IO.Directory]::CreateDirectory($Path)
    return $Path
}

function Assert-Hash([string]$Path, [string]$Expected) {
    if ($Expected -notmatch '^[A-Fa-f0-9]{64}$' -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Expected) {
        throw "SHA256 mismatch: $Path"
    }
}

function Copy-VerifiedFile([string]$Source, [string]$Destination, [string]$Sha256) {
    $Source = Get-LocalPath $Source
    $Destination = Get-LocalPath $Destination
    if (Test-Path -LiteralPath $Destination) { throw "Destination already exists: $Destination" }
    $partial = $Destination + '.partial'
    $inputStream = [IO.File]::Open($Source, 'Open', 'Read', 'Read')
    try {
        # New bytes inherit the destination ACL, not the low-integrity build ACL.
        $outputStream = [IO.File]::Open($partial, 'CreateNew', 'Write', 'None')
        try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) }
        finally { $outputStream.Dispose() }
        Assert-Hash $partial $Sha256
    } finally { $inputStream.Dispose() }
    [IO.File]::Move($partial, $Destination)
}

function Write-AtomicText([string]$Path, [string]$Text) {
    $Path = Get-LocalPath $Path
    if (Test-Path -LiteralPath $Path) { throw "Evidence already exists: $Path" }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
    $stream = [IO.File]::Open($Path + '.partial', 'CreateNew', 'Write', 'None')
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    [IO.File]::Move($Path + '.partial', $Path)
}

function Write-AtomicJson([string]$Path, $Value) {
    Write-AtomicText $Path ($Value | ConvertTo-Json -Depth 12)
}

function Assert-NormalIntegrity([string]$Path, [string]$EvidenceDirectory) {
    $acl = Join-Path $EvidenceDirectory ('acl-' + [guid]::NewGuid().ToString('N') + '.txt')
    & icacls.exe $Path /save $acl /q | Out-Null
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $acl)) { throw 'Cannot inspect the delivery integrity label.' }
    $sddl = [IO.File]::ReadAllText($acl, [Text.Encoding]::Unicode)
    if ($sddl -match '\(ML;[^)]*;;;(LW|UN|S-1-16-(0|4096))\)') {
        throw 'Low/untrusted integrity file: use a normal Downloads directory, not the workspace. Do not change ACLs.'
    }
}

function Get-ReleaseIdentity([string]$Repository) {
    $pkg = Get-Content -LiteralPath (Join-Path $Repository 'package.json') -Raw | ConvertFrom-Json
    # Windows PowerShell cannot deserialize npm's empty root-package key.
    $lockText = Get-Content -LiteralPath (Join-Path $Repository 'package-lock.json') -Raw
    if ($lockText.Contains('"__mdplusRoot"')) { throw 'Unexpected lockfile key.' }
    $lock = [regex]::Replace($lockText, '""\s*:\s*\{', '"__mdplusRoot": {') | ConvertFrom-Json
    $tauri = Get-Content -LiteralPath (Join-Path $Repository 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
    $cargo = Get-Content -LiteralPath (Join-Path $Repository 'src-tauri/Cargo.toml') -Raw
    $cargoLock = Get-Content -LiteralPath (Join-Path $Repository 'src-tauri/Cargo.lock') -Raw
    $versions = @($pkg.version, $lock.version, $lock.packages.__mdplusRoot.version, $tauri.version,
        [regex]::Match($cargo, '(?ms)^\[package\].*?^version = "([^"]+)"').Groups[1].Value,
        [regex]::Match($cargoLock, '(?m)^name = "mdplus"\r?\nversion = "([^"]+)"').Groups[1].Value)
    if ($pkg.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or @($versions | Where-Object { $_ -cne $pkg.version }).Count) {
        throw 'Version mismatch across npm, Cargo and Tauri manifests/locks.'
    }
    $buildSource = Get-Content -LiteralPath (Join-Path $Repository 'src/lib/buildInfo.ts') -Raw
    $build = [regex]::Match($buildSource, ' / ([A-Za-z0-9.-]+)`').Groups[1].Value
    if (!$build) { throw 'Missing build identifier.' }
    return [pscustomobject]@{ version = $pkg.version; build = $build; packageName = "MDPlus_$($pkg.version)_x64-setup.exe" }
}

function Read-Delivery([string]$Directory) {
    $Directory = Get-LocalPath $Directory
    $manifest = Get-Content -LiteralPath (Join-Path $Directory 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or
        $manifest.package.name -cne "MDPlus_$($manifest.version)_x64-setup.exe" -or
        $manifest.package.name -match '[\\/]' -or $manifest.payload.sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'Invalid delivery manifest.'
    }
    $files = @(Get-ChildItem -LiteralPath $Directory -Force)
    $expected = @('manifest.json', 'README.txt', 'SHA256SUMS', $manifest.package.name)
    if ($files.Count -ne 4 -or @($files | Where-Object { $_.PSIsContainer -or $_.Name -notin $expected }).Count) {
        throw 'Current directory contains unknown files; archive it manually without deleting recovery data.'
    }
    $package = Get-LocalPath (Join-Path $Directory $manifest.package.name)
    Assert-Hash $package $manifest.package.sha256
    return $manifest
}

function Publish-Delivery([string]$Staging, [string]$Root) {
    $Root = Get-LocalPath $Root
    $Staging = Get-LocalPath $Staging
    if ([IO.Path]::GetDirectoryName($Staging) -ine $Root -or [IO.Path]::GetFileName($Staging) -notlike '*.partial') {
        throw 'Staging must be a partial directory directly under the delivery root.'
    }
    $candidate = Read-Delivery $Staging
    $current = Get-LocalPath (Join-Path $Root 'current')
    $archive = $null
    if (Test-Path -LiteralPath $current) {
        $previous = Read-Delivery $current
        if ($previous.package.sha256 -eq $candidate.package.sha256) { throw 'This package is already current; no archive or overwrite performed.' }
        $archive = Get-LocalPath (Join-Path $Root ('archive\' + $previous.version + '-' + [guid]::NewGuid().ToString('N')))
        if (!(Test-InDirectory $archive (Join-Path $Root 'archive'))) { throw 'Unsafe archive path.' }
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($archive))
        # Journal before either rename. On interruption, keep both packages recoverable.
        Write-AtomicJson (Join-Path $Staging 'promotion.json') @{ previous = $current; archive = $archive; candidate = $Staging }
        [IO.File]::Move((Join-Path $Staging 'promotion.json'), (Join-Path $Root ('promotion-' + [guid]::NewGuid().ToString('N') + '.json')))
        [IO.Directory]::Move($current, $archive)
    }
    try { [IO.Directory]::Move($Staging, $current) }
    catch {
        if ($archive -and !(Test-Path -LiteralPath $current)) { [IO.Directory]::Move($archive, $current) }
        throw
    }
    return $current
}

function Assert-MDPlusIdle([string]$Installation) {
    $processes = @(Get-CimInstance Win32_Process)
    $active = @($processes | Where-Object {
        ($_.Name -in @('mdplus.exe', 'mdplus-maintenance.exe')) -or
        ($_.Name -like 'MDPlus*setup*.exe') -or
        ($_.Name -eq 'msedgewebview2.exe' -and (!$_.CommandLine -or $_.CommandLine -like '*com.mdplus.desktop*'))
    })
    if ($active.Count) { throw 'MDPlus/update/profile process is active or cannot be inspected. Save documents and close it manually; no process was killed.' }
    foreach ($file in Get-ChildItem -LiteralPath $Installation -File -Filter '*.exe') {
        $handle = [IO.File]::Open($file.FullName, 'Open', 'Read', 'None')
        $handle.Dispose()
    }
}

function Get-TreeState([hashtable]$Roots) {
    $state = [ordered]@{}
    foreach ($group in ($Roots.Keys | Sort-Object)) {
        $root = Get-LocalPath $Roots[$group]
        $files = @(); $directories = @()
        $exists = Test-Path -LiteralPath $root -PathType Container
        if ($exists) {
            $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($root)
            while ($pending.Count) {
                foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
                    $path = Get-LocalPath $item.FullName
                    $relative = $path.Substring($root.Length + 1)
                    if ($item.PSIsContainer) { $directories += $relative; $pending.Push($path) }
                    else { $files += [ordered]@{ path = $relative; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash } }
                }
            }
        } elseif (Test-Path -LiteralPath $root) { throw 'Expected a directory.' }
        $state[$group] = [ordered]@{ exists = $exists; directories = @($directories | Sort-Object); files = @($files | Sort-Object { $_.path }) }
    }
    return $state
}

function Assert-TreeState([hashtable]$Roots, $Expected) {
    if ((Get-TreeState $Roots | ConvertTo-Json -Depth 12 -Compress) -cne ($Expected | ConvertTo-Json -Depth 12 -Compress)) {
        throw 'Files changed since the snapshot; stop rather than overwrite user data.'
    }
}

function Backup-VerifiedTrees([hashtable]$Roots, [string]$Destination, [string]$RollbackPackage, [string]$RollbackSha256) {
    $Destination = Get-LocalPath $Destination
    foreach ($root in $Roots.Values) { Assert-SeparatePaths $Destination (Get-LocalPath $root) }
    if (Test-Path -LiteralPath $Destination) { throw 'Backup already exists.' }
    Assert-Hash $RollbackPackage $RollbackSha256
    $state = Get-TreeState $Roots
    $partial = New-EmptyDirectory ($Destination + '.partial')
    foreach ($group in $state.Keys) {
        if (!$state[$group].exists) { continue }
        $target = New-EmptyDirectory (Join-Path $partial $group)
        foreach ($relative in $state[$group].directories) { $null = [IO.Directory]::CreateDirectory((Join-Path $target $relative)) }
        foreach ($file in $state[$group].files) {
            Copy-VerifiedFile (Join-Path $Roots[$group] $file.path) (Join-Path $target $file.path) $file.sha256
        }
    }
    Copy-VerifiedFile $RollbackPackage (Join-Path $partial 'rollback-setup.exe') $RollbackSha256
    Assert-TreeState $Roots $state
    Write-AtomicJson (Join-Path $partial 'manifest.json') @{ createdAt = (Get-Date -Format o); roots = $Roots; state = $state; rollbackSha256 = $RollbackSha256 }
    [IO.Directory]::Move($partial, $Destination)
    return $state
}
