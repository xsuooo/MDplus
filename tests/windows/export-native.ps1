param([ValidateSet('start','html','pdf','save-pdf','cancel-pdf','inspect','finish')][string]$Stage='start')
$ErrorActionPreference='Stop'
$manifest=Get-Content 'C:\Phase1Input\manifest.json' -Raw|ConvertFrom-Json
if($env:COMPUTERNAME-eq $manifest.host -or !(Test-Path 'C:\Phase1Results')){throw 'Refusing host execution'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$exe='C:\中文 空格 测试\MDPlus\mdplus.exe'
$doc='C:\中文 空格 测试\导出 原文.md'
$result=[ordered]@{stage=$Stage;status='running';checks=@();startedAt=(Get-Date -Format o)}
function Check($condition,$message){if(!$condition){throw $message};$script:result.checks+=$message}
function Until([scriptblock]$f,$message){$end=(Get-Date).AddSeconds(90);do{if(&$f){return};Start-Sleep -Milliseconds 200}while((Get-Date)-lt $end);throw $message}
function Root{
  $script:app=Get-Process mdplus|Where-Object {$_.Path-eq $exe}|Select-Object -First 1
  [Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)
}
function ByName($name){
  $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$name)
  (Root).FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
}
function Inspect{
  $root=Root
  $items=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
  @($items|ForEach-Object {[ordered]@{name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;id=$_.Current.AutomationId}})|ConvertTo-Json -Depth 4|Set-Content "C:\Phase1Results\export-uia.json" -Encoding UTF8
  $r=$root.Current.BoundingRectangle;$b=New-Object Drawing.Bitmap([int]$r.Width,[int]$r.Height);$g=[Drawing.Graphics]::FromImage($b)
  try{$g.CopyFromScreen([int]$r.Left,[int]$r.Top,0,0,$b.Size);$b.Save("C:\Phase1Results\export-$Stage.png",[Drawing.Imaging.ImageFormat]::Png)}finally{$g.Dispose();$b.Dispose()}
}
function Paste($text){[Windows.Forms.Clipboard]::SetText($text);[Windows.Forms.SendKeys]::SendWait('^a^v')}
try{
  if($Stage-eq 'start'){
    Check (@(Get-Process mdplus -ErrorAction SilentlyContinue).Count-eq 0) 'No other sandbox editor'
    foreach($output in @('C:\Phase1Results\离线 原生文档.html','C:\Phase1Results\原生 打印.pdf')){
      if(Test-Path -LiteralPath $output){throw "Archive previous export evidence before rerunning: $output"}
    }
    [IO.File]::WriteAllText('C:\中文 空格 测试\导出 图片.svg','<svg xmlns="http://www.w3.org/2000/svg" width="140" height="80"><rect width="140" height="80" fill="teal"/></svg>')
    $text='# 原生导出 Native export'+ "`n`n" + '正文中文 English **重点**，`code`。'+"`n`n"+'![图片](<./导出 图片.svg>)'+"`n`n"+'- [x] 已完成'+"`n"+'- [ ] 未完成'+"`n`n"+'行内公式 $e^{i\pi}+1=0$。'+"`n`n"+'$$'+"`n"+'\frac{1}{2}+\sqrt{x^2+y^2}'+"`n"+'$$'+"`n`n"+'~~~mermaid'+"`n"+'graph LR'+"`n"+'A[中文起点]-->B[Native export]'+"`n"+'~~~'+"`n`n"
    $text+=(('分页校验中文 Native searchable text.'+"`n`n")*40)+'END-OF-NATIVE-EXPORT'
    [IO.File]::WriteAllText($doc,$text,(New-Object Text.UTF8Encoding($false)))
    (Get-FileHash -LiteralPath $doc).Hash|Set-Content C:\Phase1Results\export-original-hash.txt
    $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$exe;$info.Arguments='"'+$doc+'"';$info.UseShellExecute=$false
    $script:app=[Diagnostics.Process]::Start($info)
    Until {$script:app.Refresh();$script:app.MainWindowHandle-ne 0} 'No native editor'
    Until {$null-ne(ByName '导出')} 'Export unavailable'
    (ByName '导出').SetFocus()
    [Windows.Forms.SendKeys]::SendWait('^+h')
    Until {
      $texts=(Root).FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
      @($texts|Where-Object {$_.Current.Name -like '将导出可离线打开*MB*'}).Count-gt 0
    } 'Native HTML size confirmation did not appear'
    Inspect
    Check ($true) 'Native HTML size confirmation appeared'
  }elseif($Stage-eq 'html'){
    # Caller invokes this while the size confirmation is foreground.
    [Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 700
    Paste 'C:\Phase1Results\离线 原生文档.html'
    [Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Until {Test-Path 'C:\Phase1Results\离线 原生文档.html'} 'HTML was not written'
    $html=[IO.File]::ReadAllText('C:\Phase1Results\离线 原生文档.html')
    Check ($html.Contains('END-OF-NATIVE-EXPORT') -and $html.Contains('@font-face') -and $html.Contains('export-diagram')) 'Native HTML contains full content and embedded fonts/diagram'
    $bounds=[regex]::Match($html,'(?s)<div class="export-diagram">.*?viewBox="([^"]+)"').Groups[1].Value.Split(' ')
    Check ($bounds.Length-eq 4 -and [double]$bounds[2]-lt 900 -and [double]$bounds[3]-lt 200) 'Packaged CSP preserved compact diagram geometry'
    [Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Check ((Get-FileHash -LiteralPath $doc).Hash-eq (Get-Content C:\Phase1Results\export-original-hash.txt)) 'Export did not modify original document'
  }elseif($Stage-eq 'pdf'){
    # WebView2 can focus its download bubble after saving a PDF.
    [Windows.Forms.SendKeys]::SendWait('{ESC}')
    (ByName '导出').SetFocus()
    [Windows.Forms.SendKeys]::SendWait('^+p')
    Until {$null-ne(ByName '打印')} 'Native print preview did not open'
    Start-Sleep -Seconds 2
    Inspect
  }elseif($Stage-eq 'save-pdf'){
    (ByName '保存').GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 700
    Paste 'C:\Phase1Results\原生 打印.pdf'
    [Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Until {(Test-Path 'C:\Phase1Results\原生 打印.pdf') -and (Get-Item 'C:\Phase1Results\原生 打印.pdf').Length-gt 1000} 'Native PDF was not saved'
    Until {$null-ne(ByName '导出') -and (ByName '导出').Current.IsEnabled} 'Print did not release the export lock'
    Check ($true) 'Actual print preview saved PDF and released export lock'
  }elseif($Stage-eq 'cancel-pdf'){
    (ByName '取消').GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    Until {$null-ne(ByName '导出') -and (ByName '导出').Current.IsEnabled} 'Print cancel did not release export lock'
    Check ($true) 'Native print cancellation returned to usable editor'
  }elseif($Stage-eq 'finish'){
    Check (Test-Path 'C:\Phase1Results\原生 打印.pdf') 'Native PDF exists'
    Check ((Get-FileHash -LiteralPath $doc).Hash-eq (Get-Content C:\Phase1Results\export-original-hash.txt)) 'Print did not modify original document'
    Until {$null-ne(ByName '导出') -and (ByName '导出').Current.IsEnabled} 'Editor did not return after print'
    Inspect
    [void]$script:app.CloseMainWindow()
    Check ($script:app.WaitForExit(15000)) 'Export session closed without unsaved prompt'
  }else{Inspect}
  $result.status='passed'
}catch{$result.status='failed';$result.error=$_.Exception.Message;$result.location=$_.ScriptStackTrace;throw}
finally{$result.completedAt=Get-Date -Format o;$result|ConvertTo-Json -Depth 5|Set-Content "C:\Phase1Results\export-$Stage.json" -Encoding UTF8}
