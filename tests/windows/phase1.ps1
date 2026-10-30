param([ValidateSet('install','update','native')][string]$Stage='install')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$manifest=Get-Content 'C:\Phase1Input\manifest.json' -Raw|ConvertFrom-Json
if($env:COMPUTERNAME -eq $manifest.host -or !(Test-Path 'C:\Phase1Results')){throw 'Refusing host execution'}
$result=[ordered]@{stage=$Stage;status='running';checks=@()}
$base='C:\中文 空格 测试'
$installed=Join-Path $base 'MDPlus\mdplus.exe'
$settings=Join-Path $env:APPDATA 'com.mdplus.desktop\mdplus-settings.json'
function Check($condition,$message){if(!$condition){throw $message};$script:result.checks+=$message}
function Install($package,$expectedCode){
  $p=Start-Process -FilePath $package -ArgumentList @('/S','/UPDATE',"/D=$base\MDPlus") -WindowStyle Hidden -PassThru
  if(!$p.WaitForExit(180000)){throw "Installer timeout: $($p.Id)"}
  $p.Refresh();Check ($p.ExitCode-eq $expectedCode) "Installer expected exit $expectedCode; actual $($p.ExitCode)"
}
function RunProbe($mode){
  & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File 'C:\Phase1Input\native-probe.ps1' -Mode $mode
  Check ($LASTEXITCODE-eq 0) "$mode native probe passed"
}
function Launch($file=''){
  $info=New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName=$installed
  $info.UseShellExecute=$false
  $info.EnvironmentVariables['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']='--remote-debugging-address=127.0.0.1 --remote-debugging-port=9237'
  if($file){$info.Arguments='"'+$file+'"'}
  return [Diagnostics.Process]::Start($info)
}
try {
  New-Item -ItemType Directory -Path "$base\安装包","$base\临时 文件" -Force|Out-Null
  $env:TEMP="$base\临时 文件";$env:TMP=$env:TEMP
  $package="$base\安装包\candidate.exe"
  Copy-Item 'C:\Phase1Input\candidate-setup.exe' $package -Force
  Check ((Get-FileHash $package).Hash-eq $manifest.newPackageHash) 'Candidate package hash matches'
  if($Stage-in @('install','update')){
    if($Stage-eq 'install'){
      # Start with the old registered product, with a known working WebView runtime.
      $old="$base\安装包\previous.exe";Copy-Item 'C:\Phase1Input\previous-setup.exe' $old
      $p=Start-Process $old -ArgumentList @('/S',"/D=$base\MDPlus") -WindowStyle Hidden -PassThru
      Check ($p.WaitForExit(420000)) 'Old installer exited'
      $p.Refresh();Check ($p.ExitCode-eq 0 -and (Test-Path $installed)) 'Old installed executable exists'
      New-Item -ItemType Directory -Force (Split-Path $settings)|Out-Null
      [IO.File]::WriteAllText($settings,'{"theme-mode":"dark","outline-open":true}',(New-Object Text.UTF8Encoding($false)))
    }
    $oldHash=(Get-FileHash $installed).Hash;$settingsHash=(Get-FileHash $settings).Hash
    $lock=[IO.File]::Open($installed,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    try{Install $package 2}finally{$lock.Dispose()}
    Check ((Get-FileHash $installed).Hash-eq $oldHash) 'Failed locked update preserved old executable'
    Check ((Get-FileHash $settings).Hash-eq $settingsHash) 'Failed update preserved configuration'
    Install $package 0
    Check ((Get-FileHash $installed).Hash-eq $manifest.newHash) 'Updated binary equals candidate build'
    Check ((Get-FileHash $settings).Hash-eq $settingsHash) 'Successful update preserved configuration'
    Check ((Get-Item $installed).VersionInfo.ProductVersion-like '0.2.5*') 'Installed version is stage candidate'
  } else {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-address=127.0.0.1 --remote-debugging-port=9237'
    $doc="$base\原文 测试.md";'# Original document'|Set-Content $doc -Encoding UTF8
    $originalHash=(Get-FileHash $doc).Hash
    $app=Launch $doc;RunProbe 'native-ready'
    $processes=@(Get-CimInstance Win32_Process)
    $ids=@([int]$app.Id);do{$before=$ids.Count;$ids+=@($processes|Where-Object {$_.ParentProcessId-in $ids -and $_.ProcessId-notin $ids -and $_.Name-eq 'msedgewebview2.exe'}|ForEach-Object {[int]$_.ProcessId})}while($ids.Count-gt $before)
    Install $package 0
    Check ($app.WaitForExit(5000)) 'Installer gracefully closed old main process'
    Check (@($ids|Where-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue}).Count-eq 0) 'Captured WebView2 process tree exited'
    Check ((Get-FileHash $doc).Hash-eq $originalHash) 'Update did not alter original document'
    $app=Launch
    RunProbe 'native-seed'
    Install $package 2
    Check (!$app.HasExited) 'Unsaved confirmation was not bypassed or force-killed'
    # Intentional crash of only the synthetic-data process owned by this test.
    Stop-Process -InputObject $app;$app.WaitForExit(10000)|Out-Null
    Start-Sleep -Seconds 2
    $app=Launch
    RunProbe 'native-restore'
    Check ((Get-FileHash $doc).Hash-eq $originalHash) 'Recovery did not overwrite original document'
    Check ($app.WaitForExit(5000)) 'Restored session closed after explicit discard'
    Install $package 0
  }
  $result.status='passed'
}catch{$result.status='failed';$result.error=$_.Exception.Message;throw}
finally{$result.completedAt=Get-Date -Format o;$result|ConvertTo-Json -Depth 8|Set-Content "C:\Phase1Results\$Stage-result.json" -Encoding UTF8}
