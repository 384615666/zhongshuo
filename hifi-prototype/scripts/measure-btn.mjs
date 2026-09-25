/**
 * 参考图「发送按钮」精确测量。
 *
 * 用户反馈"按钮根本没有按我截图的背景色来做"。
 * 规范 §2.0 给的 `--grad` 是 `#1d4ed8 → #15649e → #0f766e`，
 * 但参考图里实际渲染出来的按钮是另一组值 —— 需要以**参考图实测**为准，
 * 因为这个按钮就是用户指的"我截图里的背景色"。
 *
 * 做法：定位按钮矩形 → 取四角与中线的实际像素 → 反推渐变端点与方向。
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

const ps = `
Add-Type -AssemblyName System.Drawing
$b=[System.Drawing.Bitmap]::FromFile('${REF}')
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
function IsDark($c){ return ($c.R + $c.G + $c.B) -lt 600 }
function Sat($c){ $mx=[Math]::Max($c.R,[Math]::Max($c.G,$c.B)); $mn=[Math]::Min($c.R,[Math]::Min($c.G,$c.B)); return $mx-$mn }

# 在 y=800..845、x=680..820 区域找"饱和色"像素的包围盒
$minX=9999;$maxX=-1;$minY=9999;$maxY=-1
for($y=795;$y -le 850;$y++){
  for($x=670;$x -le 830;$x++){
    $c=$b.GetPixel($x,$y)
    if((Sat $c) -gt 40){
      if($x -lt $minX){$minX=$x}; if($x -gt $maxX){$maxX=$x}
      if($y -lt $minY){$minY=$y}; if($y -gt $maxY){$maxY=$y}
    }
  }
}
Write-Output ("button bbox: x={0}..{1} (w={2})  y={3}..{4} (h={5})" -f $minX,$maxX,($maxX-$minX+1),$minY,$maxY,($maxY-$minY+1))

if($maxX -gt 0){
  $midY=[int](($minY+$maxY)/2)
  Write-Output "--- horizontal scan at vertical center (y=$midY) ---"
  for($x=$minX; $x -le $maxX; $x+=4){
    $c=$b.GetPixel($x,$midY); Write-Output ("x={0,4} {1}" -f $x,(Hex $c))
  }
  Write-Output "--- corners & center ---"
  $cx=[int](($minX+$maxX)/2)
  foreach($p in @(@($minX+3,$minY+3),@($maxX-3,$minY+3),@($minX+3,$maxY-3),@($maxX-3,$maxY-3),@($cx,$midY))){
    $c=$b.GetPixel($p[0],$p[1]); Write-Output ("({0},{1}) {2}" -f $p[0],$p[1],(Hex $c))
  }
}
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }));
