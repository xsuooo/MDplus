Add-Type -AssemblyName System.Drawing
function Get-PreviewInk($element){
  if(!$element){return 0}
  $r=$element.Current.BoundingRectangle
  if($r.Width-lt 100 -or $r.Height-lt 30){return 0}
  $b=New-Object Drawing.Bitmap([int]$r.Width,[int]$r.Height)
  $g=[Drawing.Graphics]::FromImage($b)
  try{
    $g.CopyFromScreen([int]$r.Left,[int]$r.Top,0,0,$b.Size)
    $background=$b.GetPixel(0,0);$ink=0
    for($y=2;$y-lt $b.Height-2;$y+=2){for($x=2;$x-lt $b.Width-2;$x+=2){
      $p=$b.GetPixel($x,$y)
      if(([Math]::Abs([int]$p.R-$background.R)+[Math]::Abs([int]$p.G-$background.G)+[Math]::Abs([int]$p.B-$background.B))-gt 90){$ink++}
    }}
    return $ink
  }finally{$g.Dispose();$b.Dispose()}
}
