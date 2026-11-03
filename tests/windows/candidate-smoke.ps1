[CmdletBinding()]
param(
    [string]$HostComputerName,
    [string]$ExpectedExeSha256,
    [string]$RunId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Provision the dedicated VM and mappings separately; this script never provisions them.
# ReadOnly=true on the input mapping is an operator prerequisite, not an ACL proof here.
function Assert-SmokeHost([string]$Machine, [string]$HostComputerName) {
    if ($Machine -ieq $HostComputerName) { throw 'REFUSED_HOST: candidate automation is never allowed on the declared host.' }
    if ($Machine -notmatch '^[A-Za-z0-9-]{1,63}\z' -or $HostComputerName -notmatch '^[A-Za-z0-9-]{1,63}\z') {
        throw 'REFUSED_IDENTITY: a nonempty machine and originating host name are required.'
    }
}

function Assert-SmokeInside([string]$Path, [string]$Root) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Root -notmatch '^[A-Za-z]:\\' -or $Path.Substring(2).Contains(':')) {
        throw 'REFUSED_PATH: only absolute local paths without alternate streams are allowed.'
    }
    $full = [IO.Path]::GetFullPath($Path)
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (!$full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'REFUSED_PATH: path is outside its dedicated directory.'
    }
    foreach ($part in $Path.Substring(3).Split('\')) {
        if (!$part -or $part -in @('.', '..') -or $part -ne $part.TrimEnd(' ', '.') -or $part -match '[<>"|?*\x00-\x1f]') {
            throw 'REFUSED_PATH: ambiguous path component.'
        }
    }
}

function Assert-SmokeHash([string]$Actual, [string]$Expected) {
    if ($Actual -notmatch '^[0-9a-fA-F]{64}\z' -or $Expected -notmatch '^[0-9a-fA-F]{64}\z' -or $Actual -ine $Expected) {
        throw 'REFUSED_HASH: candidate bytes do not match the approved SHA-256.'
    }
}

function Assert-SmokeContext($Context, [bool]$RequireSentinel = $true) {
    Assert-SmokeHost $Context.Machine $Context.HostComputerName
    if ($Context.User -cne 'WDAGUtilityAccount' -or $Context.Manufacturer -cne 'Microsoft Corporation' -or $Context.Model -cne 'Virtual Machine') {
        throw 'REFUSED_VM: actual Windows Sandbox account and Microsoft VM hardware are required.'
    }
    if ($Context.LocalAppData -ine 'C:\Users\WDAGUtilityAccount\AppData\Local' -or
        $Context.RoamingAppData -ine 'C:\Users\WDAGUtilityAccount\AppData\Roaming' -or
        $Context.InputRoot -cne 'C:\MDPlusCandidateInput' -or $Context.OutputRoot -cne 'C:\MDPlusCandidateResults') {
        throw 'REFUSED_CONTEXT: known folders or fixed mappings do not match the execution contract.'
    }
    if ($Context.RunId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\z' -or $Context.RunId -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
        throw 'REFUSED_RUN_ID: use a fresh, nonreserved directory name of at most 64 ASCII characters.'
    }
    Assert-SmokeHash $Context.ExpectedExeSha256 $Context.ExpectedExeSha256
    if (!$RequireSentinel) { return }
    $sentinel = $Context.Sentinel
    foreach ($field in @('schema','purpose','hostComputerName','candidateSha256','runId')) {
        if ($null -eq $sentinel -or $null -eq $sentinel.PSObject.Properties[$field]) { throw 'REFUSED_SENTINEL: missing required field.' }
    }
    if ($sentinel.purpose -isnot [string] -or $sentinel.hostComputerName -isnot [string] -or $sentinel.runId -isnot [string] -or
        ($sentinel.schema -isnot [int] -and $sentinel.schema -isnot [long]) -or $sentinel.schema -ne 1 -or
        $sentinel.purpose -cne 'mdplus-candidate-smoke/v1' -or $sentinel.hostComputerName -ine $Context.HostComputerName -or
        $sentinel.runId -cne $Context.RunId -or $sentinel.candidateSha256 -isnot [string]) {
        throw 'REFUSED_SENTINEL: identities differ from the explicit command-line approval.'
    }
    Assert-SmokeHash $sentinel.candidateSha256 $Context.ExpectedExeSha256
    if ($null -ne $sentinel.PSObject.Properties['sourceDigest'] -and
        ($sentinel.sourceDigest -isnot [string] -or $sentinel.sourceDigest -notmatch '^[0-9a-fA-F]{64}\z')) {
        throw 'REFUSED_SENTINEL: malformed optional declared source digest.'
    }
}

function Assert-SmokeIdentity($Expected, $Actual) {
    if ($null -eq $Actual -or $Actual.Exited -or $Actual.Id -ne $Expected.Id -or
        $Actual.StartTicks -ne $Expected.StartTicks -or $Actual.Path -ine $Expected.Path) {
        throw 'REFUSED_PROCESS: exited, reused PID or foreign executable; no action is authorized.'
    }
}

function Assert-SmokePlainPath([string]$Path, [bool]$MustExist = $true) {
    if ($Path -notmatch '^C:\\' -or $Path.Substring(2).Contains(':')) { throw 'REFUSED_PATH: only fixed C: paths are supported.' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ine $Path) { throw 'REFUSED_PATH: noncanonical path.' }
    $cursor = [IO.Path]::GetPathRoot($full)
    foreach ($part in $full.Substring($cursor.Length).Split('\')) {
        $cursor = Join-Path $cursor $part
        if (Test-Path -LiteralPath $cursor -ErrorAction Stop) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REFUSED_REPARSE: redirected paths are not supported.' }
        }
    }
    if ($MustExist -and !(Test-Path -LiteralPath $full -ErrorAction Stop)) { throw 'REFUSED_PATH: required fixed path is absent.' }
}

function Write-SmokeNewFile([string]$Path, [byte[]]$Bytes, [string]$Root) {
    Assert-SmokeInside $Path $Root
    Assert-SmokePlainPath $Path $false
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Get-SmokeFileBytes([string]$Path, [string]$Root, [int]$Limit = 67108864) {
    Assert-SmokeInside $Path $Root
    Assert-SmokePlainPath $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -gt $Limit) { throw 'FAILED_ASSERT: produced file exceeds the smoke size bound.' }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if (!$read) { throw 'FAILED_ASSERT: produced file was truncated during inspection.' }
            $offset += $read
        }
        return ,$bytes
    } finally { $stream.Dispose() }
}

function Get-SmokeText([string]$Path, [string]$Root) {
    $bytes = Get-SmokeFileBytes $Path $Root
    return [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
}

function Assert-SmokeNoOtherEditor() {
    $editors = @(Get-CimInstance Win32_Process -Filter "Name = 'mdplus.exe'" -ErrorAction Stop)
    if ($editors.Count) { throw 'REFUSED_EXISTING_APP: an MDPlus process is already running; it will not be controlled or stopped.' }
}

function Get-SmokeStamp([Diagnostics.Process]$Process) {
    $Process.Refresh()
    if ($Process.HasExited) { throw 'BLOCKED_RUNTIME: candidate or recorded descendant exited.' }
    return [pscustomobject]@{Id=$Process.Id; Path=$Process.MainModule.FileName; StartTicks=$Process.StartTime.ToUniversalTime().Ticks; Exited=$false}
}

function Get-SmokeOwnedProcess($State, [int]$ProcessId) {
    if (!$State.Owned.ContainsKey($ProcessId)) { throw 'REFUSED_PROCESS: PID is not in the recorded launch lineage.' }
    $record = $State.Owned[$ProcessId]
    if ($record.Depth -gt 16) { throw 'REFUSED_PROCESS: lineage depth exceeds the safety bound.' }
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    Assert-SmokeIdentity $record.Stamp (Get-SmokeStamp $process)
    if ($record.ParentId -ne 0) {
        $parent = Get-SmokeOwnedProcess $State $record.ParentId
        $row = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        if ($null -eq $row -or $row.ParentProcessId -ne $record.ParentId -or $record.Stamp.StartTicks -lt $State.Owned[$record.ParentId].Stamp.StartTicks) {
            throw 'REFUSED_PROCESS: descendant ancestry no longer matches the captured parent.'
        }
        Assert-SmokeIdentity $State.Owned[$record.ParentId].Stamp (Get-SmokeStamp $parent)
    }
    Assert-SmokeIdentity $record.Stamp (Get-SmokeStamp $process)
    return $process
}

function Update-SmokeChildren($State) {
    $null = Get-SmokeOwnedProcess $State $State.Root.Id
    $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    for ($depth = 1; $depth -le 16; $depth++) {
        $added = $false
        foreach ($row in $rows) {
            $childId = [int]$row.ProcessId
            $parentId = [int]$row.ParentProcessId
            if ($State.Owned.ContainsKey($childId) -or !$State.Owned.ContainsKey($parentId)) { continue }
            $parentRecord = $State.Owned[$parentId]
            if ($parentRecord.Depth -ne ($depth - 1)) { continue }
            $parent = Get-SmokeOwnedProcess $State $parentId
            try { $child = [Diagnostics.Process]::GetProcessById($childId) } catch [ArgumentException] { continue }
            if ($child.HasExited) { continue }
            $stamp = Get-SmokeStamp $child
            Assert-SmokeIdentity $parentRecord.Stamp (Get-SmokeStamp $parent)
            if ($stamp.StartTicks -lt $parentRecord.Stamp.StartTicks) { throw 'REFUSED_PROCESS: recycled parent PID cannot confer ownership.' }
            $controllable = $stamp.Path -match '^C:\\Program Files(?: \(x86\))?\\Microsoft\\EdgeWebView\\Application\\[0-9.]+\\msedgewebview2\.exe$'
            $State.Owned[$childId] = [pscustomobject]@{Stamp=$stamp;ParentId=$parentId;Depth=$depth;Controllable=$controllable}
            $State.Launch.descendants.Add($State.Owned[$childId])
            $added = $true
        }
        if (!$added) { break }
    }
}

function Start-SmokeCandidate($State, [string]$Document) {
    $State.Report.cleanup='not_run'
    Assert-SmokeInside $Document $State.Work
    Assert-SmokePlainPath $Document
    Assert-SmokePlainPath $State.Exe
    Assert-SmokeNoOtherEditor
    # Deny concurrent writes/deletion from hash verification until this process is closed.
    $State.ExeLock = [IO.File]::Open($State.Exe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    Assert-SmokeHash (Get-FileHash -LiteralPath $State.Exe -Algorithm SHA256).Hash $State.Hash
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $State.Exe
    $info.WorkingDirectory = [IO.Path]::GetDirectoryName($State.Exe)
    $info.UseShellExecute = $false
    $info.Arguments = '"' + $Document + '"'
    $State.Launch = [ordered]@{attemptedAt=[DateTime]::UtcNow.ToString('o');startReturned=$false;started=$null;observedPid=$null;
        stamp=$null;identityCaptureError=$null;exitCode=$null;cleanup='not_run';descendants=[Collections.Generic.List[object]]::new()}
    $State.Report.launches.Add($State.Launch)
    $State.Report.cleanup='blocked: launch outcome/identity unverified; manual VM inspection required'
    $State.Launch.cleanup=$State.Report.cleanup
    try {
        $process = [Diagnostics.Process]::Start($info)
        $State.Launch.startReturned=$true
        if ($null -eq $process) { throw 'BLOCKED_RUNTIME: process creation returned no observable handle.' }
        $State.Launch.started=$true
        $State.Launch.observedPid=$process.Id
        $stamp = Get-SmokeStamp $process
        if ($stamp.Path -ine $State.Exe) { throw 'REFUSED_PROCESS: launched executable path differs from the verified copy.' }
    } catch {
        $State.Launch.identityCaptureError=$_.Exception.Message
        # observedPid is evidence only; without a complete stamp there is no authorized control path.
        throw
    }
    $State.Root = $stamp
    $State.Launch.stamp = $stamp
    $State.Owned = @{}
    $State.Owned[$stamp.Id] = [pscustomobject]@{Stamp=$stamp;ParentId=0;Depth=0;Controllable=$true}
    $State.Report.cleanup='pending'
    $State.Launch.cleanup='pending'
    $State.Window = Wait-Smoke $State {
        $p = Get-SmokeOwnedProcess $State $State.Root.Id
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) { [Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle) }
    } 'candidate main window unavailable (including missing WebView2)' 30
    Assert-SmokeElement $State $State.Window
}

function Assert-SmokeElement($State, $Element) {
    if ($null -eq $Element) { throw 'BLOCKED_UIA: required element is absent.' }
    $elementId = [int]$Element.Current.ProcessId
    $null = Get-SmokeOwnedProcess $State $elementId
    if (!$State.Owned[$elementId].Controllable) { throw 'BLOCKED_UIA: UI is outside the candidate or approved WebView2 descendant paths.' }
    if ($Element.Current.IsOffscreen -or !$Element.Current.IsEnabled) { throw 'BLOCKED_UIA: element is hidden or disabled.' }
}

function Get-SmokeOwnedRoots($State) {
    Update-SmokeChildren $State
    $desktop = [Windows.Automation.AutomationElement]::RootElement
    foreach ($element in $desktop.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
        $elementId = [int]$element.Current.ProcessId
        # Only inspect/control trees whose process stamp and complete live lineage were verified.
        if ($State.Owned.ContainsKey($elementId) -and $State.Owned[$elementId].Controllable) {
            $null = Get-SmokeOwnedProcess $State $elementId
            if (!$element.Current.IsOffscreen) { $element }
        }
    }
}

function Find-SmokeElement($State, [string]$Name = '', [string]$Type = '', [string]$AutomationId = '', $Within = $null) {
    Update-SmokeChildren $State
    if ($null -ne $Within -and (!$Within.Current.IsEnabled -or $Within.Current.IsOffscreen)) { return $null }
    $roots = if ($null -ne $Within) { Assert-SmokeElement $State $Within; @($Within) } else { @(Get-SmokeOwnedRoots $State) }
    $condition = [Windows.Automation.Condition]::TrueCondition
    if ($Name) { $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name) }
    if ($AutomationId) { $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId) }
    $matches = [Collections.Generic.List[object]]::new()
    $seen = @{}
    foreach ($root in $roots) {
        foreach ($element in $root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
            if ($Type -and $element.Current.ControlType.ProgrammaticName -cne ('ControlType.' + $Type)) { continue }
            if ($element.Current.IsOffscreen -or !$element.Current.IsEnabled) { continue }
            if ($Name -and $element.Current.Name -cne $Name) { continue }
            $key = [string]::Join(',', $element.GetRuntimeId())
            if (!$seen.ContainsKey($key)) { $seen[$key]=$true; $matches.Add($element) }
        }
    }
    if ($matches.Count -gt 1) { throw 'BLOCKED_UIA: selector is ambiguous; no first-match fallback is permitted.' }
    if ($matches.Count -eq 1) { Assert-SmokeElement $State $matches[0]; return $matches[0] }
    return $null
}

function Wait-Smoke($State, [scriptblock]$Probe, [string]$Reason, [int]$Seconds = 25, [bool]$Assertion = $false) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($null -ne $State.Root) { $null = Get-SmokeOwnedProcess $State $State.Root.Id }
        $value = & $Probe
        if ($value) { return $value }
        Start-Sleep -Milliseconds 150
    } while ($clock.Elapsed.TotalSeconds -lt $Seconds)
    if ($Assertion) { throw ('FAILED_ASSERT: ' + $Reason) }
    throw ('BLOCKED_UIA: ' + $Reason)
}

function Invoke-SmokePattern($State, $Element, [ValidateSet('Read','Set','Invoke')][string]$Action, [string]$Value = '',
    $PrintPreview = $null, [string[]]$ExpectedNames = @()) {
    Assert-SmokeElement $State $Element
    $patternId = switch ($Action) {
        'Read' { [Windows.Automation.ValuePattern]::Pattern }
        'Set' { [Windows.Automation.ValuePattern]::Pattern }
        'Invoke' { [Windows.Automation.InvokePattern]::Pattern }
    }
    $pattern = $null
    if (!$Element.TryGetCurrentPattern($patternId, [ref]$pattern)) { throw ('BLOCKED_UIA: required pattern not exposed: ' + $Action) }
    Assert-SmokeElement $State $Element
    switch ($Action) {
        'Read' { return $pattern.Current.Value }
        'Set' {
            if ($pattern.Current.IsReadOnly) { throw 'BLOCKED_UIA: UIA ValuePattern is read-only.' }
            $pattern.SetValue($Value)
        }
        'Invoke' {
            if ($null -ne $PrintPreview) {
                Assert-SmokeElement $State $PrintPreview.Panel
                Assert-SmokePdfDestination $State $PrintPreview.Destination
                if (!$ExpectedNames.Count -or $Element.Current.Name -cnotin $ExpectedNames -or
                    $Element.Current.ControlType -ne [Windows.Automation.ControlType]::Button -or
                    !$Element.Current.IsEnabled -or $Element.Current.IsOffscreen) {
                    throw 'BLOCKED_UIA: print action label/state changed before Invoke.'
                }
            }
            # Last-moment semantic checks reduce drift; UIA checks and Invoke are not an atomic transaction.
            $pattern.Invoke()
        }
    }
}

function Get-SmokeSource($State) {
    $null = Wait-Smoke $State { $State.Window.Current.IsEnabled -and !$State.Window.Current.IsOffscreen } 'main window remained modal or hidden'
    $source = Find-SmokeElement $State -Name 'Markdown 源码' -Type 'Edit' -Within $State.Window
    if ($null -eq $source) {
        $toggle = Wait-Smoke $State { Find-SmokeElement $State -Name '切换源码模式' -Type 'Button' -Within $State.Window } 'source mode toggle unavailable'
        Invoke-SmokePattern $State $toggle 'Invoke'
        $source = Wait-Smoke $State { Find-SmokeElement $State -Name 'Markdown 源码' -Type 'Edit' -Within $State.Window } 'source textarea unavailable'
    }
    return $source
}

function Assert-SmokeValue($State, $Element, [string]$Expected) {
    $null = Wait-Smoke $State {
        if (!$Element.Current.IsEnabled -or $Element.Current.IsOffscreen) { return $false }
        $value = Invoke-SmokePattern $State $Element 'Read'
        $value.Replace(([string][char]13), '') -ceq $Expected.Replace(([string][char]13), '')
    } 'UIA source readback differs from expected fixture text' 15 $true
}

function Get-SmokeDialog($State, [string[]]$Titles, [string]$Message = '') {
    $matches = @()
    foreach ($root in @(Get-SmokeOwnedRoots $State)) {
        if ($root.Current.ClassName -cne '#32770' -or $root.Current.Name -cnotin $Titles) { continue }
        if ($Message) {
            $texts = @($root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) |
                Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Text -and $_.Current.Name.Contains($Message) })
            if ($texts.Count -ne 1) { continue }
        }
        $matches += $root
    }
    if ($matches.Count -gt 1) { throw 'BLOCKED_UIA: multiple matching native dialogs.' }
    if ($matches.Count -eq 1) { Assert-SmokeElement $State $matches[0]; return $matches[0] }
    return $null
}

function Invoke-SmokeDialogButton($State, $Dialog, [string]$Id) {
    $button = Wait-Smoke $State { Find-SmokeElement $State -Type 'Button' -AutomationId $Id -Within $Dialog } 'documented native dialog button unavailable'
    Invoke-SmokePattern $State $button 'Invoke'
}

function Save-SmokeDialog($State, [string[]]$Titles, [string]$Destination) {
    Assert-SmokeInside $Destination $State.Results
    Assert-SmokePlainPath $Destination $false
    if (Test-Path -LiteralPath $Destination) { throw 'REFUSED_OUTPUT: an export target already exists.' }
    $dialog = Wait-Smoke $State { Get-SmokeDialog $State $Titles } 'owned native save dialog unavailable'
    $name = Wait-Smoke $State { Find-SmokeElement $State -Type 'Edit' -AutomationId '1001' -Within $dialog } 'native file-name ValuePattern control unavailable'
    Invoke-SmokePattern $State $name 'Set' $Destination
    Assert-SmokeValue $State $name $Destination
    Assert-SmokePlainPath $Destination $false
    if (Test-Path -LiteralPath $Destination) { throw 'REFUSED_OUTPUT: export destination appeared before confirmation.' }
    Invoke-SmokeDialogButton $State $dialog '1'
    $null = Wait-Smoke $State { Test-Path -LiteralPath $Destination -PathType Leaf } 'application did not create the selected export file' 45 $true
}

function Open-SmokeExport($State, [string]$Kind) {
    $trigger = Wait-Smoke $State { Find-SmokeElement $State -Name '导出' -Type 'Button' -Within $State.Window } 'export menu unavailable or still locked'
    Invoke-SmokePattern $State $trigger 'Invoke'
    $name = if ($Kind -eq 'html') { '导出为 HTML' } else { '打印 / 另存为 PDF' }
    $item = Wait-Smoke $State {
        $found = Find-SmokeElement $State -Name $name -Type 'MenuItem' -Within $State.Window
        if ($null -eq $found -and $Kind -eq 'pdf') { $found = Find-SmokeElement $State -Name '导出为 PDF' -Type 'MenuItem' -Within $State.Window }
        $found
    } 'export menu item unavailable'
    Invoke-SmokePattern $State $item 'Invoke'
}

function Assert-SmokePdfDestination($State, $Destination) {
    Assert-SmokeElement $State $Destination
    $selection = $null
    if (!$Destination.TryGetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern, [ref]$selection)) {
        throw 'BLOCKED_UIA: print destination selection cannot be read.'
    }
    $selected = @($selection.GetCurrentSelection())
    if ($selected.Count -ne 1) { throw 'BLOCKED_UIA: print destination selection is ambiguous.' }
    Assert-SmokeElement $State $selected[0]
    # Re-read after identity queries so a formerly selected PDF item cannot validate a new printer selection.
    $current = @($selection.GetCurrentSelection())
    if ($current.Count -ne 1 -or
        [string]::Join(',', $current[0].GetRuntimeId()) -cne [string]::Join(',', $selected[0].GetRuntimeId()) -or
        $current[0].Current.Name -cnotin @('另存为 PDF','Save as PDF')) {
        throw 'BLOCKED_UIA: destination is not verified Save as PDF; physical printer actions are prohibited.'
    }
}

function Get-SmokePrintPreview($State) {
    $destination = Find-SmokeElement $State -Name '目标打印机' -Type 'ComboBox'
    if ($null -eq $destination) { $destination = Find-SmokeElement $State -Name 'Destination' -Type 'ComboBox' }
    if ($null -eq $destination) { return $null }
    Assert-SmokePdfDestination $State $destination
    $panel = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($destination)
    $mainId = [string]::Join(',', $State.Window.GetRuntimeId())
    for ($depth = 0; $depth -lt 8 -and $null -ne $panel; $depth++) {
        if ([string]::Join(',', $panel.GetRuntimeId()) -ceq $mainId) { break }
        Assert-SmokeElement $State $panel
        if ($panel.Current.Name -cin @('打印','Print') -and
            $panel.Current.ControlType.ProgrammaticName -cin @('ControlType.Window','ControlType.Pane','ControlType.Document','ControlType.Group')) {
            return [pscustomobject]@{Destination=$destination;Panel=$panel}
        }
        $panel = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($panel)
    }
    throw 'BLOCKED_UIA: named print-preview container unavailable; normal application buttons will not be used.'
}

function Get-SmokePrintButton($State, $Preview, [string[]]$Names) {
    Assert-SmokeElement $State $Preview.Panel
    $buttons = @()
    foreach ($name in $Names) {
        $button = Find-SmokeElement $State -Name $name -Type 'Button' -Within $Preview.Panel
        if ($null -ne $button) { $buttons += $button }
    }
    if ($buttons.Count -ne 1) { throw 'BLOCKED_UIA: unique button in the named print preview is unavailable.' }
    Assert-SmokePdfDestination $State $Preview.Destination
    return $buttons[0]
}

function Wait-SmokeWinRt($Operation, [Type]$ResultType) {
    # Convert the platform async result to a bounded Task; no script body is compiled/evaluated.
    $methods = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -ceq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Length -eq 1 -and
        $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType.Name -ceq ('IAsyncOperation' + [char]96 + '1')
    })
    if ($methods.Count -ne 1) { throw 'BLOCKED_PDF: Windows Runtime Task bridge is unavailable.' }
    $taskMethod = $methods[0].MakeGenericMethod([Type[]]@($ResultType))
    $task = $taskMethod.Invoke($null, @($Operation))
    if (!$task.Wait(30000)) { throw 'BLOCKED_PDF: native PDF operation timed out.' }
    return $task.Result
}

function Test-SmokePdf($State, [string]$Path) {
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $fileType = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
        $pdfType = [Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime]
    } catch { throw ('BLOCKED_PDF: native Windows PDF parser unavailable: ' + $_.Exception.Message) }
    Assert-SmokeInside $Path $State.Results
    Assert-SmokePlainPath $Path
    $pdfLock = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $bytes = Get-SmokeFileBytes $Path $State.Results
        $pdf = [Text.Encoding]::GetEncoding(28591).GetString($bytes)
        if ($bytes.Length -lt 256 -or $pdf -notmatch '^%PDF-(1\.[0-9]|2\.0)' -or $pdf -notmatch '%%EOF\s*\z') {
            throw 'FAILED_ASSERT: saved PDF has an invalid header or final EOF.'
        }
        $xref = [regex]::Match($pdf, 'startxref\s+(\d+)\s+%%EOF\s*\z')
        if (!$xref.Success) { throw 'FAILED_ASSERT: PDF final startxref is missing.' }
        $offset = [long]::Parse($xref.Groups[1].Value)
        if ($offset -lt 0 -or $offset -ge $bytes.Length) { throw 'FAILED_ASSERT: PDF xref offset is outside the produced file.' }
        $target = $pdf.Substring([int]$offset, [Math]::Min(2048, $pdf.Length - [int]$offset))
        if ($target -notmatch '^xref\s' -and $target -notmatch '^\d+\s+\d+\s+obj\s*<<[^>]*?/Type\s*/XRef\b') {
            throw 'FAILED_ASSERT: startxref does not point to an xref table/stream.'
        }
        try { $file = Wait-SmokeWinRt ([Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]::GetFileFromPathAsync($Path)) $fileType }
        catch { throw ('BLOCKED_PDF: Windows Runtime cannot open the produced PDF: ' + $_.Exception.Message) }
        try { $document = Wait-SmokeWinRt ([Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime]::LoadFromFileAsync($file)) $pdfType }
        catch {
            if ($_.Exception.Message -like 'BLOCKED_*') { throw }
            throw ('FAILED_ASSERT: native Windows PDF parser rejected the produced bytes: ' + $_.Exception.Message)
        }
        if ($document.IsPasswordProtected -or $document.PageCount -lt 1) { throw 'FAILED_ASSERT: exported PDF is protected or has no pages.' }
        if ($document.PageCount -gt 200) { throw 'BLOCKED_PDF: page count exceeds the bounded smoke review.' }
        for ($pageIndex = 0; $pageIndex -lt $document.PageCount; $pageIndex++) {
            $page = $document.GetPage([uint32]$pageIndex)
            try {
                if ($page.Size.Width -le 0 -or $page.Size.Height -le 0) { throw 'FAILED_ASSERT: native PDF page dimensions are empty.' }
            } finally { $page.Dispose() }
        }
        return [ordered]@{path=$Path;sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash;bytes=$bytes.Length;pages=$document.PageCount;
            validation='Header/EOF/xref plus Windows.Data.Pdf native page parsing; rendered glyphs, image fidelity and source correspondence remain manual'}
    } finally { $pdfLock.Dispose() }
}

function Write-SmokeExternalChange($State, [string]$Expected, [string]$Replacement) {
    Assert-SmokeInside $State.Document $State.Work
    Assert-SmokePlainPath $State.Document
    # The sole overwrite in the harness is its own synthetic document, verified under one exclusive handle.
    $stream = [IO.File]::Open($State.Document, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $false, 1024, $true)
        try { $actual=$reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($actual -cne $Expected) { throw 'FAILED_ASSERT: fixture changed unexpectedly before the external-edit scenario.' }
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Replacement)
        $stream.Position=0; $stream.SetLength(0); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
    } finally { $stream.Dispose() }
}

function Close-SmokeCandidate($State) {
    Update-SmokeChildren $State
    $process = Get-SmokeOwnedProcess $State $State.Root.Id
    if (!$process.CloseMainWindow()) { throw 'BLOCKED_CLEANUP: owned candidate did not accept a graceful close.' }
    if (!$process.WaitForExit(15000)) { throw 'BLOCKED_CLEANUP: close prompt or hung candidate remains; close the disposable VM manually.' }
    $State.Launch.exitCode = $process.ExitCode
    $State.Root = $null
    $State.Window = $null
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        $survivors = @()
        foreach ($record in @($State.Owned.Values)) {
            if ($record.ParentId -eq 0) { continue }
            try { $child = [Diagnostics.Process]::GetProcessById($record.Stamp.Id) } catch [ArgumentException] { continue }
            if (!$child.HasExited) { Assert-SmokeIdentity $record.Stamp (Get-SmokeStamp $child); $survivors += $record.Stamp.Id }
        }
        if (!$survivors.Count) { break }
        Start-Sleep -Milliseconds 150
    } while ($clock.Elapsed.TotalSeconds -lt 10)
    if ($survivors.Count) { throw 'BLOCKED_CLEANUP: recorded descendants survived; no force-stop is authorized.' }
    $State.ExeLock.Dispose(); $State.ExeLock=$null
    $State.Report.cleanup='passed'
    $State.Launch.cleanup='passed'
    if ($State.Launch.exitCode -ne 0) { throw 'FAILED_ASSERT: candidate closed with a nonzero native exit code.' }
}

function Save-SmokeUiaEvidence($State, [string]$Stage) {
    $items = [Collections.Generic.List[object]]::new()
    foreach ($root in @(Get-SmokeOwnedRoots $State)) {
        foreach ($element in $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
            if ($items.Count -ge 400) { break }
            $elementId = [int]$element.Current.ProcessId
            if (!$State.Owned.ContainsKey($elementId)) { continue }
            $null = Get-SmokeOwnedProcess $State $elementId
            $name = $element.Current.Name
            $items.Add([ordered]@{pid=$elementId;name=$name.Substring(0,[Math]::Min(240,$name.Length));type=$element.Current.ControlType.ProgrammaticName;id=$element.Current.AutomationId})
        }
    }
    $path = Join-Path $State.Results ('uia-' + $Stage + '.json')
    Write-SmokeNewFile $path ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $items.ToArray() -Depth 5))) $State.Results
}

function Invoke-CandidateSmoke() {
    $state=$null; $results=$null; $stage='preflight'; $code=2
    $report=[ordered]@{schema=1;runId=$RunId;status='not_run';candidateAccepted=$false;sourceDigestVerified=$false;
        startedAt=[DateTime]::UtcNow.ToString('o');completedAt=$null;error=$null;exitCode=$null;
        inputMapping='ReadOnly=true is an execution-operator prerequisite, not independently verified by this script';
        scope='Owned candidate UIA and synthetic VM-local fixtures only; not whole-candidate acceptance';
        cleanupScope='root-and-recorded-descendants';unobservedDescendants='not_verified';
        printTargetPolicy='Do not manually change the target during automation; UIA checks and Invoke are not atomic';
        sourceDigestDeclared=$null;environment=$null;launches=[Collections.Generic.List[object]]::new();outputs=@{};steps=[ordered]@{};
        manual=@(
            @{name='IME composition, candidate selection and undo';status='manual';execution='not_run';reason='UIA ValuePattern text replacement is not IME input'},
            @{name='DPI, zoom, accessibility and visual layout';status='manual';execution='not_run'},
            @{name='Unobserved descendants after the last process snapshot';status='manual';execution='not_run';reason='cleanup passed covers only the root and recorded descendants, not the complete process tree'},
            @{name='打印 / 另存为 PDF rendered fidelity';status='manual';execution='not_run';reason='Review glyphs, images, pagination and source correspondence in the actual produced PDF'},
            @{name='Native races, crash recovery and durable storage';status='manual';execution='not_run';reason='Bounded smoke does not replace the native test suite'}
        );cleanup='not_run'}
    foreach ($name in @('preflight','launch_and_open','unicode_save_reopen','external_reload_cancel','external_reload_accept_images','html_export','pdf_export','print_cancel','graceful_close')) {
        $report.steps[$name]=[ordered]@{status='not_run';evidence=$null}
    }
    try {
        Assert-SmokeHost ([Environment]::MachineName) $HostComputerName
        $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
        $context = [pscustomobject]@{Machine=[Environment]::MachineName;HostComputerName=$HostComputerName;User=[Environment]::UserName;
            Manufacturer=$computer.Manufacturer;Model=$computer.Model;
            LocalAppData=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData);
            RoamingAppData=[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData);
            InputRoot='C:\MDPlusCandidateInput';OutputRoot='C:\MDPlusCandidateResults';RunId=$RunId;ExpectedExeSha256=$ExpectedExeSha256;Sentinel=$null}
        Assert-SmokeContext $context $false
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            if ($identity.Name -cne ($context.Machine + '\WDAGUtilityAccount') -or $identity.IsSystem -or $identity.IsAnonymous) { throw 'REFUSED_IDENTITY: actual Windows token is not the VM-local sandbox account.' }
        } finally { $identity.Dispose() }
        $profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
        if ($profile -ine 'C:\Users\WDAGUtilityAccount') { throw 'REFUSED_PROFILE: actual Windows user profile is not the sandbox profile.' }
        foreach ($entry in @{USERPROFILE=$profile;APPDATA=$context.RoamingAppData;LOCALAPPDATA=$context.LocalAppData}.GetEnumerator()) {
            if ([Environment]::GetEnvironmentVariable($entry.Key) -ine $entry.Value) { throw 'REFUSED_PROFILE: inherited environment redirects a known folder.' }
        }
        foreach ($key in [Environment]::GetEnvironmentVariables().Keys) {
            if ([string]$key -match '^(WEBVIEW2_|TAURI_)') { throw 'REFUSED_ENVIRONMENT: inherited WebView/Tauri overrides are not allowed.' }
        }
        foreach ($path in @($context.InputRoot,$context.OutputRoot,$profile,$context.LocalAppData,$context.RoamingAppData)) { Assert-SmokePlainPath $path }
        $sentinelPath = Join-Path $context.InputRoot 'sandbox-sentinel.json'
        Assert-SmokePlainPath $sentinelPath
        if ((Get-Item -LiteralPath $sentinelPath).Length -gt 16384) { throw 'REFUSED_SENTINEL: sentinel exceeds size bound.' }
        $context.Sentinel = Get-Content -LiteralPath $sentinelPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-SmokeContext $context
        if ($null -ne $context.Sentinel.PSObject.Properties['sourceDigest']) { $report.sourceDigestDeclared=$context.Sentinel.sourceDigest }
        foreach ($base in @($context.LocalAppData,$context.RoamingAppData)) {
            foreach ($name in @('com.mdplus.desktop','MDPlus','mdplus')) {
                if (Test-Path -LiteralPath (Join-Path $base $name)) { throw 'REFUSED_EXISTING_PROFILE: use a fresh disposable VM; existing MDPlus data will not be read or changed.' }
            }
        }
        Assert-SmokeNoOtherEditor
        if ([Threading.Thread]::CurrentThread.ApartmentState -ne [Threading.ApartmentState]::STA) { throw 'BLOCKED_UIA: launch the already-approved script in an STA PowerShell session.' }
        try {
            Add-Type -AssemblyName UIAutomationClient
            Add-Type -AssemblyName UIAutomationTypes
            Add-Type -AssemblyName System.Drawing
        } catch { throw ('BLOCKED_UIA: required Windows automation assemblies unavailable: ' + $_.Exception.Message) }
        $workBase='C:\MDPlusCandidateWork'
        $work=Join-Path $workBase $RunId
        $targetResults=Join-Path $context.OutputRoot $RunId
        Assert-SmokeInside $work $workBase
        Assert-SmokeInside $targetResults $context.OutputRoot
        Assert-SmokePlainPath $work $false
        Assert-SmokePlainPath $targetResults $false
        if ((Test-Path -LiteralPath $work) -or (Test-Path -LiteralPath $targetResults)) { throw 'REFUSED_REUSE: work/results run directories must not already exist.' }
        $sourceExe=Join-Path $context.InputRoot 'candidate\mdplus.exe'
        Assert-SmokePlainPath $sourceExe
        $inputLock=[IO.File]::Open($sourceExe,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try {
            Assert-SmokeHash (Get-FileHash -LiteralPath $sourceExe -Algorithm SHA256).Hash $ExpectedExeSha256
            $null=[IO.Directory]::CreateDirectory($workBase)
            $null=New-Item -Path $work -ItemType Directory -ErrorAction Stop
            $null=New-Item -Path $targetResults -ItemType Directory -ErrorAction Stop
            $results=$targetResults
            $bin=Join-Path $work 'bin'
            $documents=Join-Path $work '中文 空格 文稿'
            $null=New-Item -Path $bin -ItemType Directory -ErrorAction Stop
            $null=New-Item -Path $documents -ItemType Directory -ErrorAction Stop
            $exe=Join-Path $bin 'mdplus.exe'
            [IO.File]::Copy($sourceExe,$exe,$false)
            Assert-SmokeHash (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash $ExpectedExeSha256
            Assert-SmokeHash (Get-FileHash -LiteralPath $sourceExe -Algorithm SHA256).Hash $ExpectedExeSha256
        } finally { $inputLock.Dispose() }
        $report.environment=[ordered]@{machine=$context.Machine;user=$context.User;manufacturer=$computer.Manufacturer;model=$computer.Model;candidateSha256=$ExpectedExeSha256;work=$work;results=$results}
        $state=@{Work=$work;Results=$results;Exe=$exe;Hash=$ExpectedExeSha256;Document=(Join-Path $documents '中文 空格 冒烟.md');Root=$null;Window=$null;Owned=@{};ExeLock=$null;Launch=$null;Report=$report}
        $pngs=@{}
        foreach ($name in @('图片一.png','图片二.png')) {
            $bitmap=[Drawing.Bitmap]::new(8,8)
            $memory=[IO.MemoryStream]::new()
            try {
                $colour=if ($name -ceq '图片一.png') { [Drawing.Color]::Crimson } else { [Drawing.Color]::RoyalBlue }
                $graphics=[Drawing.Graphics]::FromImage($bitmap)
                try { $graphics.Clear($colour) } finally { $graphics.Dispose() }
                $bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png)
                $bytes=$memory.ToArray(); $pngs[$name]=[Convert]::ToBase64String($bytes)
                Write-SmokeNewFile (Join-Path $documents $name) $bytes $work
            } finally { $memory.Dispose(); $bitmap.Dispose() }
        }
        $nl=[string][char]10
        $initial=('# 原生候选冒烟 ' + $RunId) + $nl + $nl + 'English 与中文。' + $nl + $nl + '![候选图片](<./图片一.png>)' + $nl
        Write-SmokeNewFile $state.Document ([Text.UTF8Encoding]::new($false).GetBytes($initial)) $work
        $report.steps[$stage].status='passed'

        $stage='launch_and_open'; $report.steps[$stage].status='running'
        Start-SmokeCandidate $state $state.Document
        $source=Get-SmokeSource $state
        Assert-SmokeValue $state $source $initial
        $report.steps[$stage].status='passed'; $report.steps[$stage].evidence='CLI-opened synthetic Chinese/space path; UIA source equals original bytes'

        $stage='unicode_save_reopen'; $report.steps[$stage].status='running'
        $edited=$initial + $nl + '中文 UIA 文本校验：你好，世界。ASCII-SAVE-' + $RunId + $nl
        Invoke-SmokePattern $state $source 'Set' $edited
        Assert-SmokeValue $state $source $edited
        $save=Wait-Smoke $state { Find-SmokeElement $state -Name '保存' -Type 'Button' -Within $state.Window } 'save button unavailable'
        Invoke-SmokePattern $state $save 'Invoke'
        $null=Wait-Smoke $state { (Get-SmokeText $state.Document $work) -ceq $edited } 'saved UTF-8 bytes differ from UIA input' 20 $true
        Close-SmokeCandidate $state
        Start-SmokeCandidate $state $state.Document
        $source=Get-SmokeSource $state
        Assert-SmokeValue $state $source $edited
        $report.steps[$stage].status='passed'; $report.steps[$stage].evidence='UIA ValuePattern only (not IME); exact disk bytes plus graceful close/reopen readback'

        $stage='external_reload_cancel'; $report.steps[$stage].status='running'
        $external=$edited.Replace('图片一.png','图片二.png') + $nl + 'EXTERNAL-CANCEL-' + $RunId + $nl
        Write-SmokeExternalChange $state $edited $external
        $dialog=Wait-Smoke $state { Get-SmokeDialog $state @('MDPlus') '重新加载文件' } 'external reload confirmation unavailable'
        Invoke-SmokeDialogButton $state $dialog '7'
        Assert-SmokeValue $state $source $edited
        if ((Get-SmokeText $state.Document $work) -cne $external) { throw 'FAILED_ASSERT: declining reload altered the external version.' }
        $report.steps[$stage].status='passed'; $report.steps[$stage].evidence='IDNO declined reload; local text and distinct external bytes both retained'

        $stage='external_reload_accept_images'; $report.steps[$stage].status='running'
        $final=$external + $nl + 'RELOADED-IMAGE-' + $RunId + $nl
        Write-SmokeExternalChange $state $external $final
        $dialog=Wait-Smoke $state { Get-SmokeDialog $state @('MDPlus') '重新加载文件' } 'second external reload confirmation unavailable'
        Invoke-SmokeDialogButton $state $dialog '6'
        $source=Get-SmokeSource $state
        Assert-SmokeValue $state $source $final
        $report.steps[$stage].status='passed'; $report.steps[$stage].evidence='IDYES accepted new disk content; image byte verification belongs only to the separate html_export result'
        $documentHash=(Get-FileHash -LiteralPath $state.Document -Algorithm SHA256).Hash

        $stage='html_export'; $report.steps[$stage].status='running'
        Open-SmokeExport $state 'html'
        $dialog=Wait-Smoke $state { Get-SmokeDialog $state @('MDPlus') '将导出可离线打开' } 'HTML size confirmation unavailable'
        Invoke-SmokeDialogButton $state $dialog '6'
        $htmlPath=Join-Path $results '中文 候选.html'
        Save-SmokeDialog $state @('导出 HTML') $htmlPath
        $dialog=Wait-Smoke $state { Get-SmokeDialog $state @('MDPlus') 'HTML 导出成功' } 'HTML completion notification unavailable'
        Invoke-SmokeDialogButton $state $dialog '1'
        $html=Get-SmokeText $htmlPath $results
        $main=[regex]::Match($html,'(?s)<main\b[^>]*>(.*?)</main>')
        $images=[regex]::Matches($main.Groups[1].Value,'<img\b[^>]*\bsrc="([^"]+)"')
        if (!$main.Success -or !$main.Groups[1].Value.Contains('RELOADED-IMAGE-' + $RunId) -or
            $images.Count -ne 1 -or $images[0].Groups[1].Value -cne ('data:image/png;base64,' + $pngs['图片二.png']) -or !$html.Contains('@font-face')) {
            throw 'FAILED_ASSERT: exported HTML does not contain the actual reloaded text, embedded image bytes and fonts.'
        }
        if ((Get-FileHash -LiteralPath $state.Document -Algorithm SHA256).Hash -ine $documentHash) { throw 'FAILED_ASSERT: HTML export modified the source fixture.' }
        $report.outputs.html=@{path=$htmlPath;sha256=(Get-FileHash -LiteralPath $htmlPath -Algorithm SHA256).Hash;imageSha256=(Get-FileHash -LiteralPath (Join-Path $documents '图片二.png') -Algorithm SHA256).Hash}
        $report.steps[$stage].status='passed'; $report.steps[$stage].evidence=$report.outputs.html

        $stage='pdf_export'; $report.steps[$stage].status='running'
        Open-SmokeExport $state 'pdf'
        $destination=Wait-Smoke $state { Get-SmokePrintPreview $state } 'owned PDF print-preview destination unavailable'
        $button=Get-SmokePrintButton $state $destination @('保存','Save')
        Invoke-SmokePattern $state $button 'Invoke' -PrintPreview $destination -ExpectedNames @('保存','Save')
        $pdfPath=Join-Path $results '中文 候选.pdf'
        Save-SmokeDialog $state @('另存为','Save As','Save Print Output As','将打印输出另存为') $pdfPath
        $null=Wait-Smoke $state { Find-SmokeElement $state -Name '导出' -Type 'Button' -Within $state.Window } 'print-save did not release export lock'
        $report.outputs.pdf=Test-SmokePdf $state $pdfPath
        if ((Get-FileHash -LiteralPath $state.Document -Algorithm SHA256).Hash -ine $documentHash) { throw 'FAILED_ASSERT: PDF export modified the source fixture.' }
        $report.steps[$stage].status='passed'; $report.steps[$stage].evidence=$report.outputs.pdf

        $stage='print_cancel'; $report.steps[$stage].status='running'
        $pdfHash=(Get-FileHash -LiteralPath $pdfPath -Algorithm SHA256).Hash
        Open-SmokeExport $state 'pdf'
        $destination=Wait-Smoke $state { Get-SmokePrintPreview $state } 'second owned print preview unavailable'
        $button=Get-SmokePrintButton $state $destination @('取消','Cancel')
        Invoke-SmokePattern $state $button 'Invoke' -PrintPreview $destination -ExpectedNames @('取消','Cancel')
        $null=Wait-Smoke $state { Find-SmokeElement $state -Name '导出' -Type 'Button' -Within $state.Window } 'print-cancel did not release export lock'
        if ((Get-FileHash -LiteralPath $pdfPath -Algorithm SHA256).Hash -ine $pdfHash -or
            (Get-FileHash -LiteralPath $state.Document -Algorithm SHA256).Hash -ine $documentHash) { throw 'FAILED_ASSERT: print cancellation altered the prior PDF or source.' }
        $report.steps[$stage].status='passed'; $report.steps[$stage].evidence='owned preview cancelled, export unlocked, source and prior PDF unchanged'
        Save-SmokeUiaEvidence $state 'complete'

        $stage='graceful_close'; $report.steps[$stage].status='running'
        Close-SmokeCandidate $state
        $report.steps[$stage].status='passed'; $report.cleanup='passed'
        $report.status='passed'; $code=0
    } catch {
        $report.error=$_.Exception.Message
        if ($stage -eq 'preflight' -and $report.error -like 'REFUSED_*') { $report.status='refused'; $code=2 }
        elseif ($report.error -like 'FAILED_ASSERT:*') { $report.status='failed'; $code=1 }
        elseif ($stage -eq 'preflight' -and $report.error -notlike 'BLOCKED_*') { $report.status='refused'; $code=2 }
        else { $report.status='blocked'; $code=3 }
        $report.steps[$stage].status=$report.status
        $report.steps[$stage].evidence=$report.error
        if ($report.error -like 'BLOCKED_CLEANUP:*') { $report.cleanup=$report.error }
        if ($null -ne $state -and $null -ne $state.Root -and $null -ne $state.Window) {
            try { Save-SmokeUiaEvidence $state $stage } catch { $report.outputs.uiaEvidenceError=$_.Exception.Message }
        }
    } finally {
        if ($null -ne $state -and $null -ne $state.Root) {
            try { Close-SmokeCandidate $state; $report.cleanup='passed' }
            catch {
                $report.cleanup='blocked: ' + $_.Exception.Message
                $state.Launch.cleanup=$report.cleanup
                if ($code -eq 0) { $code=3; $report.status='blocked' }
            }
        }
        if ($null -ne $state -and $null -ne $state.ExeLock) { $state.ExeLock.Dispose() }
        $report.completedAt=[DateTime]::UtcNow.ToString('o'); $report.exitCode=$code
        $json=ConvertTo-Json -InputObject $report -Depth 14
        if ($null -ne $results) {
            try { Write-SmokeNewFile (Join-Path $results 'result.json') ([Text.UTF8Encoding]::new($false).GetBytes($json)) $results }
            catch {
                $report.outputs.resultWriteError='BLOCKED_EVIDENCE: ' + $_.Exception.Message
                [Console]::Error.WriteLine($report.outputs.resultWriteError)
                if ($code -eq 0) { $code=3; $report.status='blocked' }
                $report.exitCode=$code
                $json=ConvertTo-Json -InputObject $report -Depth 14
            }
        }
        [Console]::Out.WriteLine($json)
    }
    return $code
}

exit (Invoke-CandidateSmoke)
