/**
 * 精确定位参考图里的「任务 / 讨论」分段控件并逐像素取色。
 *
 * 前一次扫描坐标猜错了（扫到一片白）。这次先在整张图里**搜索**灰色槽
 * `#eef4f7` 的连通块，找到控件真实位置再采样。
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

const ps = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
$b=[System.Drawing.Bitmap]::FromFile('${REF}')
$W=$b.Width;$H=$b.Height

Write-Output "=== 全图搜索 #eef4f7（分段控件灰槽）的包围盒 ==="
$minX=99999;$maxX=-1;$minY=99999;$maxY=-1;$n=0
$rows=@{}
for($y=0;$y -lt $H;$y++){
  for($x=0;$x -lt $W;$x++){
    $c=$b.GetPixel($x,$y)
    if($c.R -eq 238 -and $c.G -eq 244 -and $c.B -eq 247){
      $n++
      if($x -lt $minX){$minX=$x}; if($x -gt $maxX){$maxX=$x}
      if($y -lt $minY){$minY=$y}; if($y -gt $maxY){$maxY=$y}
      if(-not $rows.ContainsKey($y)){ $rows[$y]=@() }
      $rows[$y] += $x
    }
  }
}
Write-Output ("  pixels={0}  bbox x={1}..{2} y={3}..{4}" -f $n,$minX,$maxX,$minY,$maxY)

Write-Output ""
Write-Output "=== 出现 #eef4f7 的每一行及其 x 范围（前 25 行）==="
$k=0
foreach($y in ($rows.Keys | Sort-Object)){
  if($k -ge 25){ break }
  $xs=$rows[$y] | Sort-Object
  Write-Output ("  y={0,4}  n={1,3}  x={2}..{3}" -f $y,$xs.Count,$xs[0],$xs[-1])
  $k++
}

Write-Output ""
Write-Output "=== 该控件区域内逐行采样（取 x 中位线的颜色变化）==="
if($maxX -gt 0){
  $midY=[int](($minY+$maxY)/2)
  Write-Output ("  中线 y={0}：" -f $midY)
  for($x=$minX-4; $x -le $maxX+4; $x+=3){
    $c=$b.GetPixel($x,$midY); Write-Output ("    x={0,4} {1}" -f $x,(Hex $c))
  }
}
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
