# Run after phase1.ps1 -Stage install in a fresh sandbox, before the other probes.
$ErrorActionPreference='Stop'
$manifest=Get-Content 'C:\Phase1Input\manifest.json' -Raw|ConvertFrom-Json
if($env:COMPUTERNAME-eq $manifest.host -or !(Test-Path 'C:\Phase1Results')){throw 'Refusing host execution'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$exe='C:\中文 空格 测试\MDPlus\mdplus.exe'
$doc='C:\中文 空格 测试\排版 原生测试.md'
$text="# 排版校准 Typography`n`n正文 English 应自然阅读。**重点清晰**，不改变代码字形。`n`n~~~typescript`nconst title = `"中文 标题`";`nif (title !== `"`") return title;`n~~~`n`n"
$text+=((0..20|ForEach-Object {"## 阅读段落 $_`n`n这是一段中文 English 混排技术文档。$(-join ('Reading remains clear. '*12))`n"}) -join "`n")
$result=[ordered]@{status='running';checks=@();method='actual installed WebView2 UIA/keyboard, persistent settings and file hash';startedAt=(Get-Date -Format o)}
function Check($condition,$message){if(!$condition){throw $message};$script:result.checks+=$message}
function Until([scriptblock]$f,$message){$end=(Get-Date).AddSeconds(25);do{if(&$f){return};Start-Sleep -Milliseconds 100}while((Get-Date)-lt $end);throw $message}
function Root {
  $script:app.Refresh()
  [Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)
}
function ByName($name,$type=$null){
  $root=Root;if(!$root){return $null}
  $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$name)
  if($type){
    $typeCondition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,$type)
    $condition=New-Object Windows.Automation.AndCondition($condition,$typeCondition)
  }
  $root.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
}
function InvokeName($name){
  Until {$null-ne(ByName $name ([Windows.Automation.ControlType]::Button))} "Missing control $name"
  $element=ByName $name ([Windows.Automation.ControlType]::Button)
  $pattern=$null
  if($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke()}
  else{
    # WebView2 exposes aria-haspopup buttons through ExpandCollapse, not Invoke.
    $element.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  }
}
function SelectionName($name) {
  $element=ByName $name ([Windows.Automation.ControlType]::ComboBox)
  return $element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
}
function Choose($name,$index,$label) {
  Until {$null-ne(ByName $name ([Windows.Automation.ControlType]::ComboBox))} "Missing font control $name"
  $element=ByName $name ([Windows.Automation.ControlType]::ComboBox)
  $element.SetFocus()
  # Arrow keys commit a closed HTML select; Enter would open its native popup.
  [Windows.Forms.SendKeys]::SendWait('{HOME}')
  for($i=0;$i-lt $index;$i++){[Windows.Forms.SendKeys]::SendWait('{DOWN}')}
  Until {(SelectionName $name)-eq $label} "Font selection did not apply: $label"
}
function SourceText { (ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value }
function SourceSelection { ((ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.TextPattern]::Pattern).GetSelection()|Select-Object -First 1).GetText(-1) }
function Launch {
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$exe;$info.Arguments='"'+$doc+'"';$info.UseShellExecute=$false
  $script:app=[Diagnostics.Process]::Start($info)
  Until {$script:app.Refresh();$script:app.MainWindowHandle-ne 0} 'No native window'
  Until {$null-ne(ByName '切换源码模式')} 'Editor not ready'
}
function Capture($name) {
  $rect=(Root).Current.BoundingRectangle
  $bitmap=New-Object Drawing.Bitmap([int]$rect.Width,[int]$rect.Height)
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  try{$graphics.CopyFromScreen([int]$rect.Left,[int]$rect.Top,0,0,$bitmap.Size);$bitmap.Save("C:\Phase1Results\$name.png",[Drawing.Imaging.ImageFormat]::Png)}
  finally{$graphics.Dispose();$bitmap.Dispose()}
}
try {
  Check (@(Get-Process mdplus -ErrorAction SilentlyContinue).Count-eq 0) 'No other sandbox editor'
  [IO.File]::WriteAllText($doc,$text,(New-Object Text.UTF8Encoding($false)))
  $originalHash=(Get-FileHash -LiteralPath $doc).Hash
  Launch
  InvokeName '排版设置'
  Until {$null-ne(ByName '界面与正文字体')} 'Typography controls not available'
  Check ((SelectionName '界面与正文字体')-eq 'MiSans') 'Native body default is MiSans'
  Check ((SelectionName '源码与代码字体')-eq 'JetBrains Mono + 更纱黑体') 'Native code default is JetBrains / Sarasa'
  Capture 'typography-default'
  InvokeName '关闭排版设置'
  (ByName '切换源码模式').GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle()
  Until {$null-ne(ByName 'Markdown 源码')} 'Source did not open'
  $before=SourceText
  (ByName 'Markdown 源码').SetFocus()
  [Windows.Forms.SendKeys]::SendWait('^{HOME}{DOWN 5}{HOME}+{END}')
  Start-Sleep -Milliseconds 100
  $selected=SourceSelection
  Check (![string]::IsNullOrEmpty($selected)) 'Native source selection established'
  InvokeName '排版设置'
  Choose '界面与正文字体' 2 '霞鹜文楷'
  Check ((SelectionName '源码与代码字体')-eq 'JetBrains Mono + 更纱黑体') 'Body change leaves code preference unchanged'
  Choose '源码与代码字体' 2 'Cascadia Code + MiSans'
  Check ((SelectionName '界面与正文字体')-eq '霞鹜文楷') 'Code change leaves body preference unchanged'
  Start-Sleep -Milliseconds 400
  Check ((SourceText)-eq $before -and (SourceSelection)-eq $selected) 'Native font changes preserve draft and source selection'
  Capture 'typography-source'
  [Windows.Forms.SendKeys]::SendWait('{ESC}')
  Until {$null-eq(ByName '界面与正文字体')} 'Escape did not close typography panel'
  Check ([Windows.Automation.AutomationElement]::FocusedElement.Current.Name-eq '排版设置') 'Escape returned focus to typography trigger'
  [void]$script:app.CloseMainWindow()
  Check ($script:app.WaitForExit(15000)) 'Font choices did not dirty the document'
  Check ((Get-FileHash -LiteralPath $doc).Hash-eq $originalHash) 'Typography did not rewrite the Markdown file'
  Launch
  InvokeName '排版设置'
  Until {$null-ne(ByName '界面与正文字体')} 'Reopened panel missing'
  Check ((SelectionName '界面与正文字体')-eq '霞鹜文楷') 'Body preference survives process restart'
  Check ((SelectionName '源码与代码字体')-eq 'Cascadia Code + MiSans') 'Code preference survives process restart'
  InvokeName '关闭排版设置'
  Capture 'typography-reopened'
  [void]$script:app.CloseMainWindow()
  Check ($script:app.WaitForExit(15000)) 'Native typography session closed cleanly'
  $result.status='passed'
}catch{$result.status='failed';$result.error=$_.Exception.Message;$result.location=$_.ScriptStackTrace;throw}
finally{$result.completedAt=Get-Date -Format o;$result|ConvertTo-Json -Depth 5|Set-Content 'C:\Phase1Results\typography-native.json' -Encoding UTF8}
