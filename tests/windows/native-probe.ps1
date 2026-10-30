param([ValidateSet('native-ready','native-seed','native-restore')][string]$Mode)
$ErrorActionPreference='Stop'
$manifest=Get-Content 'C:\Phase1Input\manifest.json' -Raw|ConvertFrom-Json
if($env:COMPUTERNAME-eq $manifest.host){throw 'Refusing host execution'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$exe='C:\中文 空格 测试\MDPlus\mdplus.exe'
$recovery=Join-Path $env:LOCALAPPDATA 'com.mdplus.desktop\recovery-v1'
$result=[ordered]@{mode=$Mode;status='running';method='installed WebView through Windows UIA, actual sandbox clipboard and filesystem'}
function Until([scriptblock]$probe,[string]$message){$end=(Get-Date).AddSeconds(30);do{if(&$probe){return};Start-Sleep -Milliseconds 150}while((Get-Date)-lt $end);throw $message}
function ByName([string]$name){
  $p=@(Get-Process mdplus -ErrorAction SilentlyContinue|Where-Object {$_.Path-eq $exe})
  if($p.Count-ne 1){return $null}
  $root=[Windows.Automation.AutomationElement]::FromHandle($p[0].MainWindowHandle)
  if(!$root){return $null}
  $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$name)
  return $root.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
}
function InvokeName([string]$name){
  Until {$null-ne(ByName $name)} "Missing native control: $name"
  (ByName $name).GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}
function Source{
  $toggle=(ByName '切换源码模式').GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
  if($toggle.Current.ToggleState-ne [Windows.Automation.ToggleState]::On){$toggle.Toggle()}
  Until {$null-ne(ByName 'Markdown 源码')} 'Source field missing'
}
try {
  Until {$null-ne(ByName '切换源码模式')} 'Native app not ready'
  if($Mode-eq 'native-seed'){
    InvokeName '新建'
    InvokeName '空白文档 从一个空白的页面开始'
    Source
    $field=ByName 'Markdown 源码'
    $field.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue("# 崩溃恢复测试`n`n尚未保存的中文草稿`n`n")
    $bitmap=New-Object Drawing.Bitmap(180,100)
    $g=[Drawing.Graphics]::FromImage($bitmap)
    try{
      $g.Clear([Drawing.Color]::Teal)
      [Windows.Forms.Clipboard]::SetImage($bitmap)
      $field.SetFocus()
      [Windows.Forms.SendKeys]::SendWait('^{END}')
      [Windows.Forms.SendKeys]::SendWait('^v')
      Until {(ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value.Contains('mdplus-image:')} 'Native clipboard paste failed'
    }finally{$g.Dispose();$bitmap.Dispose();[Windows.Forms.Clipboard]::Clear()}
    Until {
      $files=@(Get-ChildItem $recovery -Filter snapshot.json -Recurse -ErrorAction SilentlyContinue)
      foreach($file in $files){
        $s=Get-Content $file.FullName -Raw -Encoding UTF8|ConvertFrom-Json
        if($s.markdown.Contains('尚未保存的中文草稿') -and $s.images.Count-eq 1){
          if(Test-Path -LiteralPath (Join-Path $file.DirectoryName $s.images[0].key)){
            @{id=$s.id;path=$file.FullName}|ConvertTo-Json|Set-Content 'C:\Phase1Results\native-seed-id.json' -Encoding UTF8
            return $true
          }
        }
      };return $false
    } 'Text and actual clipboard image were not durably checkpointed'
  }elseif($Mode-eq 'native-restore'){
    InvokeName '恢复副本'
    Start-Sleep -Milliseconds 500
    $p=Get-Process mdplus|Where-Object {$_.Path-eq $exe}
    $root=[Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    $rect=$root.Current.BoundingRectangle
    $capture=New-Object Drawing.Bitmap([int]$rect.Width,[int]$rect.Height)
    $graphics=[Drawing.Graphics]::FromImage($capture)
    try{
      $graphics.CopyFromScreen([int]$rect.Left,[int]$rect.Top,0,0,$capture.Size)
      $capture.Save('C:\Phase1Results\recovered-native.png',[Drawing.Imaging.ImageFormat]::Png)
    }finally{$graphics.Dispose();$capture.Dispose()}
    Source
    $text=(ByName 'Markdown 源码').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
    if(!$text.Contains('尚未保存的中文草稿') -or !$text.Contains('mdplus-image:')){throw 'Recovered draft or image reference missing'}
    $seed=Get-Content 'C:\Phase1Results\native-seed-id.json' -Raw|ConvertFrom-Json
    if(!(Test-Path -LiteralPath $seed.path)){throw 'Recovery deleted its only durable copy'}
    $app=Get-Process mdplus|Where-Object {$_.Path-eq $exe}
    [void]$app.CloseMainWindow()
    InvokeName '放弃'
    if(!$app.WaitForExit(15000)){throw 'Explicit discard failed to close the restored session'}
    if(Test-Path -LiteralPath $seed.path){throw 'Explicit discard retained its recovery manifest'}
  }
  $result.status='passed'
}catch{$result.status='failed';$result.error=$_.Exception.Message;throw}
finally{$result|ConvertTo-Json -Depth 5|Set-Content "C:\Phase1Results\$Mode.json" -Encoding UTF8}
