$ErrorActionPreference='Stop'
$manifest=Get-Content 'C:\Phase1Input\manifest.json' -Raw|ConvertFrom-Json
if($env:COMPUTERNAME-eq $manifest.host -or !(Test-Path 'C:\Phase1Results')){throw 'Refusing host execution'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$exe='C:\中文 空格 测试\MDPlus\mdplus.exe'
$doc='C:\中文 空格 测试\连续性 测试.md'
$marker='连续性选区中文'
$paragraphs=0..49|ForEach-Object {"## 段落 $_`n`n$marker $_ $(-join ('示例内容 mixed text '*10))`n"}
$markdown="![photo](./图片 文件.svg)`n`n"+($paragraphs -join "`n")
$result=[ordered]@{status='running';checks=@();method='actual installed WebView2 UIA text selection and keyboard; real disk'}
function Check($condition,$message){if(!$condition){throw $message};$script:result.checks+=$message}
function Until([scriptblock]$f,$message){$end=(Get-Date).AddSeconds(20);do{if(&$f){return};Start-Sleep -Milliseconds 100}while((Get-Date)-lt $end);throw $message}
function ByName($name){
  $script:app.Refresh()
  $root=[Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)
  if(!$root){return $null}
  $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$name)
  return $root.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
}
function InvokeName($name){Until {$null-ne(ByName $name)} "Missing $name";(ByName $name).GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()}
function ToggleSource{(ByName '切换源码模式').GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle()}
function FieldText{(ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)}
function Selected{((FieldText).GetSelection()|Select-Object -First 1).GetText(-1)}
try{
  Check (@(Get-Process mdplus -ErrorAction SilentlyContinue).Count-eq 0) 'No other sandbox editor instance'
  [IO.File]::WriteAllText($doc,$markdown,(New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText('C:\中文 空格 测试\图片 文件.svg','<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="180" height="100" fill="teal"/></svg>')
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$exe;$info.Arguments='"'+$doc+'"';$info.UseShellExecute=$false
  $script:app=[Diagnostics.Process]::Start($info)
  Until {$script:app.Refresh();$script:app.MainWindowHandle-ne 0} 'No editor window'
  Until {$null-ne(ByName '切换源码模式')} 'Editor not ready'
  ToggleSource
  Until {$null-ne(ByName 'Markdown 源码')} 'Source did not open'
  $target="$marker 25"
  $field=ByName 'Markdown 源码';$field.SetFocus()
  $range=(FieldText).DocumentRange.FindText($target,$false,$false)
  Check ($null-ne $range) 'Middle source paragraph exists'
  # WebView2's UIA provider does not consistently implement TextRange.ScrollIntoView.
  [Windows.Forms.SendKeys]::SendWait('^{HOME}')
  [Windows.Forms.SendKeys]::SendWait('{DOWN 80}')
  [Windows.Forms.SendKeys]::SendWait('{HOME}+{END}')
  Start-Sleep -Milliseconds 150
  $target=Selected
  # Font-dependent wrapping can put visual line 80 on an empty Markdown line.
  for($i=0;$i-lt 8 -and [string]::IsNullOrEmpty($target);$i++){
    [Windows.Forms.SendKeys]::SendWait('{DOWN}{HOME}+{END}')
    Start-Sleep -Milliseconds 100
    $target=Selected
  }
  Check (![string]::IsNullOrEmpty($target)) 'Keyboard selected a visible source line'
  $range=(FieldText).GetSelection()|Select-Object -First 1
  $bounds=$range.GetBoundingRectangles()
  InvokeName '保存'
  Until {![IO.File]::ReadAllText($doc).Contains('mdplus-image:')} 'Save did not rewrite the image token'
  Start-Sleep -Milliseconds 300
  Check ((Selected)-eq $target) 'Native save preserved selected middle source text'
  $after=((FieldText).GetSelection()|Select-Object -First 1).GetBoundingRectangles()
  $result.boundsBefore=$bounds
  $result.boundsAfter=$after
  Check ($after.Length-ge 1 -and $bounds.Length-ge 1 -and [Math]::Abs($after[0].Top-$bounds[0].Top)-lt 3) 'Save preserved source viewport'
  ToggleSource
  Start-Sleep -Milliseconds 250
  ToggleSource
  Until {$null-ne(ByName 'Markdown 源码')} 'Source did not return'
  Check ((Selected)-eq $target) 'Mode round trip preserved exact source selection'
  InvokeName '新建'
  InvokeName '空白文档 从一个空白的页面开始'
  Until {$null-ne(ByName '连续性 测试.md')} 'Original tab missing'
  (ByName '连续性 测试.md').GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
  Until {$null-ne(ByName 'Markdown 源码')} 'Per-tab source mode was not restored'
  Check ((Selected)-eq $target) 'Tab return preserved source selection'
  $field=ByName 'Markdown 源码'
  $value=$field.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
  $value.SetValue($value.Current.Value+' phase2-undo-marker')
  Start-Sleep -Milliseconds 150
  InvokeName '保存'
  Until {[IO.File]::ReadAllText($doc).Contains('phase2-undo-marker')} 'Native input did not reach disk'
  (ByName 'Markdown 源码').SetFocus()
  Start-Sleep -Milliseconds 100
  [Windows.Forms.SendKeys]::SendWait('^z')
  Until {!(ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value.Contains('phase2-undo-marker')} 'Undo did not survive save'
  Check (!(ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value.Contains('mdplus-image:')) 'Undo did not restore stale image tokens'
  InvokeName '保存'
  Until {![IO.File]::ReadAllText($doc).Contains('phase2-undo-marker')} 'Final save failed'
  [void]$script:app.CloseMainWindow()
  Check ($script:app.WaitForExit(15000)) 'Clean continuity session closed normally'
  $result.status='passed'
}catch{$result.status='failed';$result.error=$_.Exception.Message;throw}
finally{$result|ConvertTo-Json -Depth 6|Set-Content 'C:\Phase1Results\continuity-native.json' -Encoding UTF8}
