$ErrorActionPreference='Stop'
$manifest=Get-Content 'C:\Phase1Input\manifest.json' -Raw|ConvertFrom-Json
if($env:COMPUTERNAME-eq $manifest.host -or !(Test-Path 'C:\Phase1Results')){throw 'Refusing host execution'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'preview-pixels.ps1')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MediaMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
$exe='C:\中文 空格 测试\MDPlus\mdplus.exe'
$doc='C:\中文 空格 测试\媒体 交互测试.md'
$result=[ordered]@{status='running';checks=@();method='installed WebView2 UIA, real mouse/keyboard and synthetic files';startedAt=(Get-Date -Format o)}
function Check($value,$message){if(!$value){throw $message};$script:result.checks+=$message}
function Until([scriptblock]$f,$message){$end=(Get-Date).AddSeconds(30);do{if(&$f){return};Start-Sleep -Milliseconds 150}while((Get-Date)-lt $end);throw $message}
function Root{$script:app.Refresh();[Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)}
function ByName($name,$type=$null){
  $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$name)
  if($type){$other=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,$type);$condition=New-Object Windows.Automation.AndCondition($condition,$other)}
  (Root).FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
}
function InvokeName($name){
  Until {$null-ne(ByName $name ([Windows.Automation.ControlType]::Button))} "Missing button $name"
  $element=ByName $name ([Windows.Automation.ControlType]::Button)
  $pattern=$null
  if($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke()}
  else{$element.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle()}
}
function ClickElement($element){
  $r=$element.Current.BoundingRectangle
  [void][MediaMouse]::SetCursorPos([int]($r.Left+$r.Width/2),[int]($r.Top+$r.Height/2))
  [MediaMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[MediaMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}
function Capture($name){
  $r=(Root).Current.BoundingRectangle;$b=New-Object Drawing.Bitmap([int]$r.Width,[int]$r.Height);$g=[Drawing.Graphics]::FromImage($b)
  try{$g.CopyFromScreen([int]$r.Left,[int]$r.Top,0,0,$b.Size);$b.Save("C:\Phase1Results\$name.png",[Drawing.Imaging.ImageFormat]::Png)}finally{$g.Dispose();$b.Dispose()}
}
function ToggleSource{(ByName '切换源码模式').GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle()}
try{
  Check (@(Get-Process mdplus -ErrorAction SilentlyContinue).Count-eq 0) 'No other sandbox editor'
  [IO.File]::WriteAllText('C:\中文 空格 测试\图片 中文.svg','<svg xmlns="http://www.w3.org/2000/svg" width="140" height="80"><rect width="140" height="80" fill="teal"/></svg>')
  $text="# 媒体测试`n`n![media photo](<./图片 中文.svg>)`n`n~~~mermaid`ngraph LR`nA[中文起点]-->B[English endpoint]`n~~~`n`n末尾正文。`n"
  [IO.File]::WriteAllText($doc,$text,(New-Object Text.UTF8Encoding($false)))
  $hash=(Get-FileHash -LiteralPath $doc).Hash
  $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$exe;$info.Arguments='"'+$doc+'"';$info.UseShellExecute=$false
  $script:app=[Diagnostics.Process]::Start($info)
  Until {$script:app.Refresh();$script:app.MainWindowHandle-ne 0} 'No media window'
  Until {$null-ne(ByName 'media photo' ([Windows.Automation.ControlType]::Image))} 'Image missing'
  ClickElement (ByName 'media photo' ([Windows.Automation.ControlType]::Image))
  Check ($null-eq(ByName 'Mermaid 图表源码')) 'Image click did not enter source'
  InvokeName '放大查看图片'
  Until {$null-ne(ByName '图片查看器')} 'Image viewer did not open'
  Capture 'media-image-viewer'
  InvokeName '放大预览'
  [Windows.Forms.SendKeys]::SendWait('^n')
  Check ($null-eq(ByName '空白文档 从一个空白的页面开始')) 'Viewer blocked background new-document shortcut'
  [Windows.Forms.SendKeys]::SendWait('{ESC}')
  Until {$null-eq(ByName '图片查看器')} 'Image viewer did not close'
  Check ((Get-FileHash -LiteralPath $doc).Hash-eq $hash) 'Viewing did not write Markdown'
  # Viewer restores the selected node in the actual editor, not a detached control.
  [Windows.Forms.Clipboard]::Clear()
  [Windows.Forms.SendKeys]::SendWait('^c')
  Start-Sleep -Milliseconds 150
  Check ([Windows.Forms.Clipboard]::ContainsData([Windows.Forms.DataFormats]::Html)) 'Selected image can be copied as rich clipboard content'
  [Windows.Forms.SendKeys]::SendWait('{DELETE}^z')
  ToggleSource
  Until {$null-ne(ByName 'Markdown 源码')} 'Source unavailable'
  Until {(ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value.Contains('图片 中文.svg')} 'Source did not synchronize restored image'
  $source=(ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
  Check ($source.Contains('图片 中文.svg')) 'Delete then undo retained original image reference'
  ToggleSource
  Until {$null-ne(ByName '编辑图表')} 'Explicit diagram edit button missing'
  InvokeName '放大查看图表'
  Until {$null-ne(ByName '图表查看器')} 'Diagram viewer did not open'
  Until {(Get-PreviewInk (ByName '图表放大预览'))-gt 100} 'Diagram viewer is blank despite a valid layout box'
  $result.diagramInk=Get-PreviewInk (ByName '图表放大预览')
  Check ($true) 'Native diagram viewer contains painted graph pixels'
  Capture 'media-diagram-viewer'
  InvokeName '原始大小'
  InvokeName '关闭查看器'
  Until {$null-eq(ByName '图表查看器')} 'Diagram viewer did not close'
  InvokeName '编辑图表'
  Until {$null-ne(ByName 'Mermaid 图表源码')} 'Explicit editing did not open source'
  $field=ByName 'Mermaid 图表源码'
  Check ($field.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value.Contains('中文起点')) 'Diagram source preserved'
  ClickElement $field
  [Windows.Forms.Clipboard]::SetText("graph LR`nA[中文起点]-->B[native media draft]")
  [Windows.Forms.SendKeys]::SendWait('^a^v')
  Until {(ByName 'Mermaid 图表源码').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value.Contains('native media draft')} 'Native paste did not enter diagram editor'
  [Windows.Forms.SendKeys]::SendWait('^s')
  Until {[IO.File]::ReadAllText($doc).Contains('native media draft')} 'Keyboard save missed live diagram draft'
  Check ($null-ne(ByName 'Mermaid 图表源码')) 'Saving live diagram did not close its editor'
  Capture 'media-diagram-editor'
  InvokeName '预览'
  Until {$null-eq(ByName 'Mermaid 图表源码')} 'Diagram preview did not exit source'
  InvokeName '保存'
  Start-Sleep -Milliseconds 500
  [void]$script:app.CloseMainWindow()
  Check ($script:app.WaitForExit(15000)) 'Media session closed cleanly'
  $result.status='passed'
}catch{$result.status='failed';$result.error=$_.Exception.Message;$result.location=$_.ScriptStackTrace;throw}
finally{$result.completedAt=Get-Date -Format o;$result|ConvertTo-Json -Depth 5|Set-Content 'C:\Phase1Results\media-native.json' -Encoding UTF8}
