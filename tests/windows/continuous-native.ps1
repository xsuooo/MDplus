$ErrorActionPreference='Stop'
$manifest=Get-Content C:\Phase1Input\manifest.json -Raw|ConvertFrom-Json
if($env:COMPUTERNAME-eq $manifest.host -or !(Test-Path C:\Phase1Results)){throw 'Refusing host execution'}
if((Test-Path C:\Phase1Results\continuous-native.json) -or (Test-Path -LiteralPath 'C:\Phase1Results\连续 验收')){throw 'Archive previous continuous evidence before starting another run'}
Start-Transcript -Path C:\Phase1Results\continuous-execution.log -Append|Out-Null
Copy-Item -LiteralPath $PSCommandPath -Destination C:\Phase1Results\continuous-script.ps1
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'preview-pixels.ps1')
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ContinuousMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll", EntryPoint="SendMessageW")] public static extern IntPtr EditMessage(IntPtr window, uint message, IntPtr arg, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] public static extern IntPtr GetText(IntPtr window, uint message, IntPtr count, StringBuilder text);
}
'@
$exe='C:\中文 空格 测试\MDPlus\mdplus.exe'
$base='C:\Phase1Results\连续 验收'
$original=Join-Path $base '正式 文档.md'
$copy=Join-Path $base '另存为 目录\副本 文档.md'
$html=Join-Path $base '离线 导出.html'
$pdf=Join-Path $base '连续 打印.pdf'
$recovery=Join-Path $env:LOCALAPPDATA 'com.mdplus.desktop\recovery-v1'
$result=[ordered]@{status='running';startedAt=(Get-Date -Format o);candidateHash=$manifest.newHash;checks=@();processes=@();method='single evolving synthetic document; installed WebView2 UIA, real clipboard, disk and print'}
function Persist {
  $path='C:\Phase1Results\continuous-native.json';$temp="$path.tmp"
  [IO.File]::WriteAllText($temp,($script:result|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  if(Test-Path -LiteralPath $path){[IO.File]::Replace($temp,$path,[NullString]::Value)}else{[IO.File]::Move($temp,$path)}
}
function Check($value,$message){if(!$value){throw $message};$script:result.checks+=@{check=$message;at=(Get-Date -Format o)};Persist;Write-Host $message}
function Until([scriptblock]$f,$message){$script:result.waitingFor=$message;Persist;$end=(Get-Date).AddSeconds(90);do{if(&$f){return};Start-Sleep -Milliseconds 150}while((Get-Date)-lt $end);throw $message}
function Root{$script:app.Refresh();[Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)}
function ByName($name,$type=$null){
  $c=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$name)
  if($type){$t=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,$type);$c=New-Object Windows.Automation.AndCondition($c,$t)}
  (Root).FindFirst([Windows.Automation.TreeScope]::Descendants,$c)
}
function InvokeName($name){
  Until {$null-ne(ByName $name ([Windows.Automation.ControlType]::Button))} "Missing button $name"
  $e=ByName $name ([Windows.Automation.ControlType]::Button);$p=$null
  if($e.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$p)){$p.Invoke()}
  elseif($e.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$p)){$p.Expand()}
  else{$e.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle()}
}
function Source([bool]$on=$true){
  $toggle=(ByName '切换源码模式').GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
  if(($toggle.Current.ToggleState-eq [Windows.Automation.ToggleState]::On)-ne $on){$toggle.Toggle()}
  Until {
    $current=(ByName '切换源码模式').GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Current.ToggleState
    (($current-eq [Windows.Automation.ToggleState]::On)-eq $on) -and (($null-ne(ByName 'Markdown 源码'))-eq $on)
  } 'Editor mode did not settle'
}
function Text{(ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value}
function FieldPattern{(ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)}
function Selected{((FieldPattern).GetSelection()|Select-Object -First 1).GetText(-1)}
function SelectionPosition{
  $previous='';$stable=0;$end=(Get-Date).AddSeconds(5)
  do{
    $range=(FieldPattern).GetSelection()|Select-Object -First 1
    $rects=$range.GetBoundingRectangles()
    $sample=@{text=$range.GetText(-1);rects=@($rects|ForEach-Object {@{top=$_.Top;left=$_.Left;width=$_.Width;height=$_.Height}})}
    $key=$sample|ConvertTo-Json -Depth 4 -Compress
    if($key-eq $previous){$stable++}else{$stable=0};$previous=$key
    if($stable-ge 2 -and $rects.Count-gt 0){return $sample}
    Start-Sleep -Milliseconds 100
  }while((Get-Date)-lt $end)
  throw 'Selected text geometry did not settle'
}
function Focus($element){
  if($element.Current.HasKeyboardFocus){return}
  $shell=New-Object -ComObject WScript.Shell
  if(!$shell.AppActivate($script:app.Id)){throw 'Cannot activate test window'}
  $element.SetFocus()
  Until {$element.Current.HasKeyboardFocus} 'Input focus did not settle'
}
function Paste($text){
  $field=[Windows.Automation.AutomationElement]::FocusedElement
  $value=$field.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
  [Windows.Forms.Clipboard]::SetText($text);[Windows.Forms.SendKeys]::SendWait('^v')
  Until {$value.Current.Value.Contains($text.Replace("`r`n","`n"))} 'Clipboard text did not reach the focused input'
}
function ClickInput($element){
  $r=$element.Current.BoundingRectangle
  [void][ContinuousMouse]::SetCursorPos([int]($r.Left+$r.Width/2),[int]($r.Top+$r.Height/2))
  [ContinuousMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[ContinuousMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Until {$element.Current.HasKeyboardFocus} 'Clicked input did not receive focus'
}
function NativeControl($class,$id){
  $a=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty,$class)
  $b=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,$id)
  (Root).FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.AndCondition($a,$b)))
}
function InputFile($path){
  # The native common dialog exposes HWNDs but not Value/Invoke patterns in this WebView host.
  Until {$null-ne(NativeControl 'Edit' '1001')} 'Native file-name control is not ready'
  $field=NativeControl 'Edit' '1001'
  [Windows.Forms.Clipboard]::SetText($path)
  [void][ContinuousMouse]::EditMessage([IntPtr]$field.Current.NativeWindowHandle,177,[IntPtr]::Zero,[IntPtr](-1))
  [void][ContinuousMouse]::EditMessage([IntPtr]$field.Current.NativeWindowHandle,770,[IntPtr]::Zero,[IntPtr]::Zero)
  Until {
    $text=New-Object Text.StringBuilder 32768
    [void][ContinuousMouse]::GetText([IntPtr]$field.Current.NativeWindowHandle,13,[IntPtr]$text.Capacity,$text)
    $text.ToString()-eq $path
  } 'Native file-name control did not accept the Unicode path'
  Until {$null-ne(NativeControl 'Button' '1') -and (NativeControl 'Button' '1').Current.IsEnabled} 'Native file save button is not ready'
  $r=(NativeControl 'Button' '1').Current.BoundingRectangle
  [void][ContinuousMouse]::SetCursorPos([int]($r.Left+$r.Width/2),[int]($r.Top+$r.Height/2))
  [ContinuousMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[ContinuousMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}
function Launch($path=''){
  $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$exe;$info.UseShellExecute=$false
  if($path){$info.Arguments='"'+$path+'"'}
  $script:app=[Diagnostics.Process]::Start($info);$script:result.processes+=@{id=$script:app.Id;started=(Get-Date -Format o)}
  Until {$script:app.Refresh();$script:app.MainWindowHandle-ne 0} 'Window missing'
  Until {$null-ne(ByName '切换源码模式')} 'Editor not ready'
}
function Capture($name){
  $r=(Root).Current.BoundingRectangle;$b=New-Object Drawing.Bitmap([int]$r.Width,[int]$r.Height);$g=[Drawing.Graphics]::FromImage($b)
  try{$g.CopyFromScreen([int]$r.Left,[int]$r.Top,0,0,$b.Size);$b.Save("C:\Phase1Results\continuous-$name.png",[Drawing.Imaging.ImageFormat]::Png)}finally{$g.Dispose();$b.Dispose()}
}
function Images($path){
  $text=[IO.File]::ReadAllText($path)
  $refs=[regex]::Matches($text,'!\[[^\]]*\]\(<?([^)>]+)>?\)')
  $hashes=@();foreach($ref in $refs){$p=Join-Path (Split-Path $path) ([Uri]::UnescapeDataString($ref.Groups[1].Value));if(!(Test-Path -LiteralPath $p)){throw "Missing saved image $p"};$hashes+=(Get-FileHash -LiteralPath $p).Hash}
  return @($hashes|Sort-Object)
}
function Choose($name,$index,$expected){
  Until {$null-ne(ByName $name ([Windows.Automation.ControlType]::ComboBox))} "Missing font control $name"
  $e=ByName $name ([Windows.Automation.ControlType]::ComboBox);$e.SetFocus();Until {$e.Current.HasKeyboardFocus} 'Font control focus did not settle';[Windows.Forms.SendKeys]::SendWait('{HOME}')
  for($i=0;$i-lt $index;$i++){[Windows.Forms.SendKeys]::SendWait('{DOWN}')}
  Until {$e.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value-eq $expected} "Font choice did not settle: $name"
}
function PrintDialog{
  [Windows.Forms.SendKeys]::SendWait('{ESC}');Focus (ByName '导出');[Windows.Forms.SendKeys]::SendWait('^+p')
  Until {$null-ne(ByName '打印')} 'Print preview missing'
  Until {$null-ne((ByName '打印' ([Windows.Automation.ControlType]::Window)).FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::ComboBox))))} 'Printer selector missing'
  $combo=(ByName '打印' ([Windows.Automation.ControlType]::Window)).FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::ComboBox)))
  $combo.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  Until {$null-ne(ByName '另存为 PDF' ([Windows.Automation.ControlType]::ListItem))} 'Built-in Save as PDF destination missing'
  (ByName '另存为 PDF' ([Windows.Automation.ControlType]::ListItem)).GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
  Until {$null-ne(ByName '保存' ([Windows.Automation.ControlType]::Button)) -and (ByName '保存' ([Windows.Automation.ControlType]::Button)).Current.IsEnabled} 'PDF destination is not ready'
}
try{
  Check (@(Get-Process mdplus -ErrorAction SilentlyContinue).Count-eq 0) 'No other sandbox editor'
  Check ((Get-FileHash -LiteralPath $exe).Hash-eq $manifest.newHash) 'Installed bytes match the accepted candidate payload'
  if(Test-Path -LiteralPath $base){throw 'Use a fresh output directory; never overwrite earlier continuous evidence'}
  New-Item -ItemType Directory -Path (Join-Path $base '另存为 目录') -Force|Out-Null
  $fixture=@'
# 连续验收 Continuous acceptance

正文中文 English **重点** 与 `code`，行内公式 $e^{i\pi}+1=0$。

~~~mermaid
graph LR
A[中文起点]-->B[Continuous graph]
~~~

- [x] 已完成
- [ ] 待处理

| Name | 说明 |
| --- | --- |
| item | 中文 English |

~~~typescript
const title = "连续验收";
~~~

'@
  $fixture+=((0..29|ForEach-Object {"`n## 阅读段落 $_`n`n连续选区中文 $_ $('Mixed text 内容 '*8)`n"})-join "`n")
  $fixture+="`n`n## 两张剪贴板图片`n`n"
  Launch
  InvokeName '新建';InvokeName '空白文档 从一个空白的页面开始'
  Until {$null-eq(ByName '空白文档 从一个空白的页面开始') -and $null-ne((Root).FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem))))} 'New document is not ready'
  Source
  ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^a');Paste $fixture
  Until {(Text).Contains('两张剪贴板图片')} 'Long mixed-language paste did not arrive'
  foreach($color in @([Drawing.Color]::Teal,[Drawing.Color]::OrangeRed)){
    $before=[regex]::Matches((Text),'mdplus-image:').Count
    $bitmap=New-Object Drawing.Bitmap(180,100);$g=[Drawing.Graphics]::FromImage($bitmap)
    try{
      $g.Clear($color);[Windows.Forms.Clipboard]::SetImage($bitmap)
      ClickInput (ByName 'Markdown 源码');$beforeText=Text
      # SendInput can return before a different process has handled its keys.
      [Windows.Forms.SendKeys]::SendWait('^{END}{ENTER}')
      Until {(Text)-eq ($beforeText+"`n")} 'Newline before image paste did not arrive'
      [Windows.Forms.SendKeys]::SendWait('^v')
      Until {[regex]::Matches((Text),'mdplus-image:').Count-eq $before+1} 'Actual clipboard image missing'
      Check ($true) "Actual clipboard image $($before+1) inserted"
    }finally{$g.Dispose();$bitmap.Dispose()}
  }
  ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^{END}{ENTER 2}');Paste 'END-OF-CONTINUOUS-DOCUMENT'
  Until {(Text).Contains('END-OF-CONTINUOUS-DOCUMENT')} 'End marker did not arrive'
  $draft=Text
  Check ([regex]::Matches($draft,'mdplus-image:').Count-eq 2) 'Two actual clipboard images are present in the source draft'
  Source $false;Source
  Check ((Text).Contains('END-OF-CONTINUOUS-DOCUMENT') -and [regex]::Matches((Text),'mdplus-image:').Count-eq 2) 'Unsaved mode roundtrip preserves long draft and both images'
  [void]$script:app.CloseMainWindow();InvokeName '取消'
  Until {$null-eq(ByName '放弃')} 'Close cancellation did not dismiss the dialog'
  Check (!$script:app.HasExited -and (Text).Contains('END-OF-CONTINUOUS-DOCUMENT')) 'Cancel window close preserves the same draft'
  Until {
    foreach($file in @(Get-ChildItem $recovery -Filter snapshot.json -Recurse -ErrorAction SilentlyContinue)){
      $s=Get-Content $file.FullName -Raw -Encoding UTF8|ConvertFrom-Json
      if($s.markdown.Contains('END-OF-CONTINUOUS-DOCUMENT') -and $s.images.Count-eq 2){$script:snapshot=$s;$script:snapshotPath=$file.FullName;return $true}
    };return $false
  } 'Draft and both images were not checkpointed'
  $imageHashes=@($script:snapshot.images|ForEach-Object {(Get-FileHash -LiteralPath (Join-Path (Split-Path $script:snapshotPath) $_.key)).Hash}|Sort-Object)
  Check ($imageHashes.Count-eq 2 -and $imageHashes[0]-ne $imageHashes[1]) 'Recovery stores two distinct complete image payloads'
  $package='C:\中文 空格 测试\安装包\continuous-candidate.exe'
  Copy-Item -LiteralPath C:\Phase1Input\candidate-setup.exe -Destination $package
  Check ((Get-FileHash -LiteralPath $package).Hash-eq $manifest.newPackageHash) 'Local installer copy matches the candidate package'
  $installer=Start-Process -FilePath $package -ArgumentList @('/S','/UPDATE','/D=C:\中文 空格 测试\MDPlus') -WindowStyle Hidden -PassThru
  if(!$installer.WaitForExit(180000)){throw 'Dirty update did not return'};$installer.Refresh()
  Check ($installer.ExitCode-eq 2 -and !$script:app.HasExited -and $null-ne(ByName '放弃')) 'Installer refuses this dirty session without killing it'
  InvokeName '取消'
  Capture 'draft-before-crash'
  # Only this script-owned process, containing synthetic data, is intentionally crashed.
  Stop-Process -InputObject $script:app;$script:app.WaitForExit(10000)|Out-Null;Start-Sleep -Seconds 2
  Launch;InvokeName '恢复副本'
  Until {$null-ne(ByName 'END-OF-CONTINUOUS-DOCUMENT')} 'Restored document is not ready'
  Source
  Check ((Text).Contains('END-OF-CONTINUOUS-DOCUMENT') -and [regex]::Matches((Text),'mdplus-image:').Count-eq 2) 'Restart restores the same long draft and both image references'
  Check (Test-Path -LiteralPath $script:snapshotPath) 'Recovery keeps the durable source until save succeeds'
  ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^s');InputFile $original
  Until {(Test-Path -LiteralPath $original) -and [IO.File]::ReadAllText($original).Contains('END-OF-CONTINUOUS-DOCUMENT')} 'First save did not write the restored document'
  Until {!(Text).Contains('mdplus-image:')} 'First save left transient image references'
  Check ((@(Images $original)-join ',')-eq ($imageHashes-join ',')) 'First save migrates both recovered images byte-for-byte'
  ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^{HOME}{DOWN 65}{HOME}+{END}')
  $selection=Selected
  for($i=0;$i-lt 8 -and [string]::IsNullOrEmpty($selection);$i++){[Windows.Forms.SendKeys]::SendWait('{DOWN}{HOME}+{END}');$selection=Selected}
  Check (![string]::IsNullOrEmpty($selection)) 'Middle source selection established'
  $beforePosition=SelectionPosition;$selection=$beforePosition.text
  $result.selectionPositions=@{before=$beforePosition};Persist
  InvokeName '保存';Source $false;Source
  Check ((Selected)-eq $selection) 'Save plus mode roundtrip preserves exact middle selection'
  $modePosition=SelectionPosition;$result.selectionPositions.mode=$modePosition;Persist
  InvokeName '新建';InvokeName '空白文档 从一个空白的页面开始'
  Until {$null-eq(ByName '空白文档 从一个空白的页面开始') -and (Root).FindAll([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem))).Count-eq 2} 'Second document is not ready'
  (ByName '正式 文档.md').GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
  Until {$null-ne(ByName 'Markdown 源码')} 'Tab return lost source mode'
  $afterPosition=SelectionPosition;$result.selectionPositions.tab=$afterPosition;Persist
  Check ($afterPosition.text-eq $selection -and [Math]::Abs($beforePosition.rects[0].top-$afterPosition.rects[0].top)-lt 3) 'Tab return retains middle selection and viewport'
  ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^{END}{ENTER}');Paste 'UNDO-AFTER-SAVE-MARKER';InvokeName '保存'
  Until {[IO.File]::ReadAllText($original).Contains('UNDO-AFTER-SAVE-MARKER')} 'Saved edit missing'
  ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^z')
  Until {!(Text).Contains('UNDO-AFTER-SAVE-MARKER')} 'Undo after save failed'
  InvokeName '保存';Until {![IO.File]::ReadAllText($original).Contains('UNDO-AFTER-SAVE-MARKER')} 'Undo save did not reach disk'
  Check ((@(Images $original)-join ',')-eq ($imageHashes-join ',')) 'Undo after save keeps both durable images'
  ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^{HOME}');Source $false
  Until {$null-ne(ByName '编辑图表')} 'Graph editor unavailable'
  InvokeName '编辑图表';Until {$null-ne(ByName 'Mermaid 图表源码')} 'Graph source missing'
  ClickInput (ByName 'Mermaid 图表源码');[Windows.Forms.SendKeys]::SendWait('^a');Paste "graph LR`nA[中文起点]-->B[Continuous final graph]";[Windows.Forms.SendKeys]::SendWait('^s')
  Until {[IO.File]::ReadAllText($original).Contains('Continuous final graph')} 'Ctrl+S missed unblurred graph draft'
  Check ($null-ne(ByName 'Mermaid 图表源码')) 'Live graph save keeps editing active'
  InvokeName '预览';Until {(Get-PreviewInk (ByName 'Mermaid 图表预览'))-gt 100} 'Graph preview is blank'
  InvokeName '排版设置';Choose '界面与正文字体' 2 '霞鹜文楷';Choose '源码与代码字体' 1 'Fira Code + 霞鹜文楷';InvokeName '关闭排版设置'
  foreach($cycle in 1..3){
    $button=@('切换主题,当前为深色','切换主题,当前为浅色','切换主题,当前为跟随系统')|ForEach-Object {ByName $_}|Where-Object {$null-ne $_}|Select-Object -First 1
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke();Start-Sleep -Seconds 2
    Until {(Get-PreviewInk (ByName 'Mermaid 图表预览'))-gt 100} 'Theme made graph blank'
  }
  Check ($true) 'Font changes and full theme cycle keep a painted graph in the same document'
  Capture 'graph-and-theme'
  Source;ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^s');Start-Sleep -Milliseconds 300
  $originalHash=(Get-FileHash -LiteralPath $original).Hash
  [Windows.Forms.SendKeys]::SendWait('^+s');InputFile $copy
  Until {(Test-Path -LiteralPath $copy) -and [IO.File]::ReadAllText($copy).Contains('END-OF-CONTINUOUS-DOCUMENT')} 'Save As did not finish'
  Check ((Get-FileHash -LiteralPath $original).Hash-eq $originalHash) 'Save As leaves the original document unchanged'
  Check ((@(Images $copy)-join ',')-eq ($imageHashes-join ',')) 'Save As into another Chinese/space directory retains both image payloads'
  $copyHash=(Get-FileHash -LiteralPath $copy).Hash
  ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^+h')
  Until {$all=(Root).FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition);@($all|Where-Object {$_.Current.Name-like '将导出可离线打开*MB*'}).Count-gt 0} 'HTML size confirmation missing'
  [Windows.Forms.SendKeys]::SendWait('{ENTER}');InputFile $html
  Until {(Test-Path -LiteralPath $html) -and [IO.File]::ReadAllText($html).Contains('END-OF-CONTINUOUS-DOCUMENT')} 'HTML export incomplete'
  [Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $htmlText=[IO.File]::ReadAllText($html)
  Check ([regex]::Matches($htmlText,'<img\b').Count-eq 2 -and $htmlText.Contains('Continuous final graph') -and $htmlText.Contains('@font-face')) 'Same-document export contains both clipboard images, final graph, fonts and end marker'
  PrintDialog;Capture 'print-preview'
  InvokeName '保存';InputFile $pdf
  Until {(Test-Path -LiteralPath $pdf) -and (Get-Item $pdf).Length-gt 1000} 'Actual PDF was not written'
  Until {$null-ne(ByName '导出') -and (ByName '导出').Current.IsEnabled} 'PDF did not release export lock'
  PrintDialog;InvokeName '取消'
  Until {$null-ne(ByName '导出') -and (ByName '导出').Current.IsEnabled} 'Print cancel did not release export lock'
  Check ((Get-FileHash $original).Hash-eq $originalHash -and (Get-FileHash $copy).Hash-eq $copyHash) 'HTML/PDF save and print cancellation leave both Markdown files unchanged'
  Source;ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^{END}{ENTER}');Paste 'POST-EXPORT-EDIT';InvokeName '保存'
  Until {[IO.File]::ReadAllText($copy).Contains('POST-EXPORT-EDIT')} 'Editor unusable after export'
  Check ((Get-FileHash $original).Hash-eq $originalHash) 'Post-export editing writes only the Save As destination'
  $copyHash=(Get-FileHash $copy).Hash
  [void]$script:app.CloseMainWindow();Check ($script:app.WaitForExit(15000)) 'Continuous session closes normally'
  Launch $copy
  Until {@((Root).FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)|Where-Object {$_.Current.Name.Contains('POST-EXPORT-EDIT')}).Count-gt 0} 'Reopened document is not ready'
  Source
  Check ((Text).Contains('POST-EXPORT-EDIT') -and (Text).Contains('Continuous final graph') -and [regex]::Matches((Text),'mdplus-image:').Count-eq 2 -and ![IO.File]::ReadAllText($copy).Contains('mdplus-image:')) 'Normal restart loads both image previews while the saved file retains durable paths'
  Check ((@(Images $copy)-join ',')-eq ($imageHashes-join ',') -and (Get-FileHash $copy).Hash-eq $copyHash) 'Normal restart preserves file and image hashes'
  InvokeName '排版设置'
  Until {$null-ne(ByName '界面与正文字体' ([Windows.Automation.ControlType]::ComboBox))} 'Reopened typography panel is not ready'
  Check ((ByName '界面与正文字体' ([Windows.Automation.ControlType]::ComboBox)).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value-eq '霞鹜文楷') 'Body font survives normal restart'
  Check ((ByName '源码与代码字体' ([Windows.Automation.ControlType]::ComboBox)).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value-eq 'Fira Code + 霞鹜文楷') 'Code font survives normal restart'
  InvokeName '关闭排版设置';ClickInput (ByName 'Markdown 源码');[Windows.Forms.SendKeys]::SendWait('^{HOME}');Source $false
  Until {(Get-PreviewInk (ByName 'Mermaid 图表预览'))-gt 100} 'Reopened graph is blank';Capture 'reopened'
  [void]$script:app.CloseMainWindow();Check ($script:app.WaitForExit(15000)) 'Final reopened session closes normally'
  $result.originalHash=$originalHash;$result.finalCopyHash=$copyHash;$result.imageHashes=$imageHashes;$result.status='passed'
}catch{
  $result.status='failed';$result.error=$_.Exception.Message;$result.location=$_.ScriptStackTrace
  try{Capture 'failure';$items=(Root).FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition);@($items|ForEach-Object {@{name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName}})|ConvertTo-Json|Set-Content C:\Phase1Results\continuous-failure-uia.json -Encoding UTF8}catch{}
  throw
}finally{$result.completedAt=Get-Date -Format o;Persist;Stop-Transcript|Out-Null}
