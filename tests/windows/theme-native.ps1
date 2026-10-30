$ErrorActionPreference='Stop'
$manifest=Get-Content C:\Phase1Input\manifest.json -Raw|ConvertFrom-Json
if($env:COMPUTERNAME-eq $manifest.host -or !(Test-Path C:\Phase1Results)){throw 'Refusing host execution'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
. (Join-Path $PSScriptRoot 'preview-pixels.ps1')
$exe='C:\中文 空格 测试\MDPlus\mdplus.exe'
$doc='C:\中文 空格 测试\主题 几何.md'
$result=[ordered]@{status='running';checks=@();samples=@();method='installed WebView2 UIA geometry sampling; not frame-by-frame visual grading';startedAt=(Get-Date -Format o)}
function Check($value,$message){if(!$value){throw $message};$script:result.checks+=$message}
function Root{$script:app.Refresh();[Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)}
function ByName($name){
  $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$name)
  (Root).FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
}
function Until([scriptblock]$test,$message){$end=(Get-Date).AddSeconds(60);do{if(&$test){return};Start-Sleep -Milliseconds 100}while((Get-Date)-lt $end);throw $message}
try{
  Check (@(Get-Process mdplus -ErrorAction SilentlyContinue).Count-eq 0) 'No other sandbox editor'
  [IO.File]::WriteAllText($doc,"# Theme geometry`n`n~~~mermaid`ngraph LR`nA[中文起点]-->B[English endpoint]`n~~~`n`nTHEME-END",[Text.UTF8Encoding]::new($false))
  $hash=(Get-FileHash -LiteralPath $doc).Hash
  $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$exe;$info.Arguments='"'+$doc+'"';$info.UseShellExecute=$false
  $script:app=[Diagnostics.Process]::Start($info)
  Until {$script:app.Refresh();$script:app.MainWindowHandle-ne 0} 'Native window missing'
  Until {$null-ne(ByName '放大查看图表') -and (ByName '放大查看图表').Current.IsEnabled} 'Initial diagram not loaded'
  Until {(Get-PreviewInk (ByName 'Mermaid 图表预览'))-gt 100} 'Native diagram image is blank'
  $result.initialInk=Get-PreviewInk (ByName 'Mermaid 图表预览')
  $before=(ByName 'Mermaid 图表预览').Current.BoundingRectangle
  Check ($before.Width-gt 100 -and $before.Height-lt 200) 'Initial native diagram has compact dimensions'
  foreach($cycle in 1..3){
    $button=@('切换主题,当前为深色','切换主题,当前为跟随系统','切换主题,当前为浅色')|ForEach-Object {ByName $_}|Where-Object {$null-ne $_}|Select-Object -First 1
    $mode=$button.Current.Name
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    $end=(Get-Date).AddSeconds(5)
    do{
      $frame=ByName 'Mermaid 图表预览'
      if($null-eq $frame){throw 'Theme lost its diagram preview'}
      $r=$frame.Current.BoundingRectangle
      $result.samples+=@{mode=$mode;left=$r.Left;top=$r.Top;width=$r.Width;height=$r.Height}
      if([Math]::Abs($r.Top-$before.Top)-gt 1 -or [Math]::Abs($r.Left-$before.Left)-gt 1 -or [Math]::Abs($r.Width-$before.Width)-gt 1 -or [Math]::Abs($r.Height-$before.Height)-gt 1){throw 'Theme moved or resized the native diagram'}
      Start-Sleep -Milliseconds 40
    }while((Get-Date)-lt $end)
    Until {(Get-PreviewInk (ByName 'Mermaid 图表预览'))-gt 100} 'Theme replacement is blank'
  }
  Check ($true) 'Dark/system/light cycle retained diagram geometry in all sampled frames'
  Check ((Get-FileHash -LiteralPath $doc).Hash-eq $hash) 'Theme did not rewrite Markdown'
  [void]$script:app.CloseMainWindow();Check ($script:app.WaitForExit(15000)) 'Theme session closed without unsaved prompt'
  $result.status='passed'
}catch{$result.status='failed';$result.error=$_.Exception.Message;throw}
finally{$result.completedAt=Get-Date -Format o;$result|ConvertTo-Json -Depth 6|Set-Content C:\Phase1Results\theme-native.json -Encoding UTF8}
