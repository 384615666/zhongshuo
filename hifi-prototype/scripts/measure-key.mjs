/**
 * 参考图关键控件精确测量（用户三处反馈的取证）。
 *
 * 只做测量，不改代码。输出：
 *  1. 侧栏选中项的底色与圆角
 *  2. 发送按钮的渐变端点与圆角
 *  3. 回复串列的背景色（白 / 灰）
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';
const GRAD = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\approved-selected-gradient.png';

const ps = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
function Sat($c){ $mx=[Math]::Max($c.R,[Math]::Max($c.G,$c.B)); $mn=[Math]::Min($c.R,[Math]::Min($c.G,$c.B)); return $mx-$mn }

$g=[System.Drawing.Bitmap]::FromFile('${GRAD}')
Write-Output "### A. approved-selected-gradient.png（110x40）纯背景取样"
foreach($x in 12,20,30,40,50,60,70,80,90,96){
  $c=$g.GetPixel($x,6); Write-Output ("  x={0,3} {1}" -f $x,(Hex $c))
}
$g.Dispose()

$b=[System.Drawing.Bitmap]::FromFile('${REF}')
Write-Output ""
Write-Output "### B. 参考图：侧栏选中项（开发大厅）"
# 侧栏约 x=8..238；选中项在 y≈285..320
$minX=9999;$maxX=-1;$minY=9999;$maxY=-1
for($y=275;$y -le 330;$y++){
  for($x=5;$x -le 245;$x++){
    $c=$b.GetPixel($x,$y)
    # 选中底是浅蓝，B 明显高于 R
    if(($c.B - $c.R) -gt 8 -and $c.B -gt 230){
      if($x -lt $minX){$minX=$x}; if($x -gt $maxX){$maxX=$x}
      if($y -lt $minY){$minY=$y}; if($y -gt $maxY){$maxY=$y}
    }
  }
}
Write-Output ("  bbox x={0}..{1} (w={2}) y={3}..{4} (h={5})" -f $minX,$maxX,($maxX-$minX+1),$minY,$maxY,($maxY-$minY+1))
if($maxX -gt 0){
  $midY=[int](($minY+$maxY)/2)
  Write-Output "  水平扫描（避开文字，取上方 3px 处）:"
  $scanY = $minY + 3
  foreach($x in $minX+2,$minX+10,$minX+30,$minX+80,$minX+140,$minX+190,$maxX-3){
    if($x -ge $minX -and $x -le $maxX){ $c=$b.GetPixel($x,$scanY); Write-Output ("    x={0,4} {1}" -f $x,(Hex $c)) }
  }
}

Write-Output ""
Write-Output "### C. 参考图：发送按钮渐变"
$bminX=9999;$bmaxX=-1;$bminY=9999;$bmaxY=-1
for($y=805;$y -le 860;$y++){
  for($x=640;$x -le 860;$x++){
    $c=$b.GetPixel($x,$y)
    if((Sat $c) -gt 50){
      if($x -lt $bminX){$bminX=$x}; if($x -gt $bmaxX){$bmaxX=$x}
      if($y -lt $bminY){$bminY=$y}; if($y -gt $bmaxY){$bmaxY=$y}
    }
  }
}
Write-Output ("  bbox x={0}..{1} (w={2}) y={3}..{4} (h={5})" -f $bminX,$bmaxX,($bmaxX-$bminX+1),$bminY,$bmaxY,($bmaxY-$bminY+1))
if($bmaxX -gt 0){
  $topY = $bminY + 3
  Write-Output "  顶行（文字上方，纯渐变）:"
  foreach($x in $bminX+2,$bminX+8,$bminX+16,$bminX+24,$bminX+32,$bminX+40,$bminX+48,$bminX+56,$bminX+64,$bminX+72,$bminX+80,$bminX+88,$bmaxX-2){
    if($x -ge $bminX -and $x -le $bmaxX){ $c=$b.GetPixel($x,$topY); Write-Output ("    x={0,4} {1}" -f $x,(Hex $c)) }
  }
  Write-Output "  底行:"
  $botY = $bmaxY - 2
  foreach($x in $bminX+2,$bminX+20,$bminX+40,$bminX+60,$bminX+80,$bmaxX-2){
    if($x -ge $bminX -and $x -le $bmaxX){ $c=$b.GetPixel($x,$botY); Write-Output ("    x={0,4} {1}" -f $x,(Hex $c)) }
  }
}

Write-Output ""
Write-Output "### D. 参考图：各列背景（区分白 / 灰）"
foreach($x in 300,500,700,850,1000,1200,1350){
  $vals=@()
  foreach($y in 150,250,350,450,550,650,750){ $vals += (Hex $b.GetPixel($x,$y)) }
  Write-Output ("  x={0,4}: {1}" -f $x, ($vals -join ' '))
}
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }));
