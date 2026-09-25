/**
 * 用户截图 2 的内容分布图 —— 确认「发送按钮」是否真的不见了。
 *
 * 用户："选中后直接全白什么都看不见了"。
 * 若输入区获得焦点（蓝框）后发送按钮变成白底白字，就会在截图里"消失"。
 * 本脚本把非白像素的分布画出来，定位每个可见元素。
 */

import { execFileSync } from 'node:child_process';

const S2 = 'C:\\Users\\user\\.dsh\\attachments\\v1\\objects\\fd\\fd45b4dfbb2344f74d492e81213bd571d5c047fd6edc46f0912fbcc1aae55e1d';

const ps = `
Add-Type -AssemblyName System.Drawing
$b=[System.Drawing.Bitmap]::FromFile('${S2}')
$W=$b.Width; $H=$b.Height
Write-Output ("image {0}x{1}" -f $W,$H)

Write-Output ""
Write-Output "=== 按列统计非白像素数（每 8 列一档），找各元素水平位置 ==="
for($x=0;$x -lt $W;$x+=8){
  $n=0
  for($y=0;$y -lt $H;$y++){
    $c=$b.GetPixel($x,$y)
    if(-not ($c.R -gt 250 -and $c.G -gt 250 -and $c.B -gt 250)){ $n++ }
  }
  $bar = '#' * [Math]::Min(60,[int]($n/2))
  Write-Output ("  x={0,4} n={1,3} {2}" -f $x,$n,$bar)
}

Write-Output ""
Write-Output "=== 按行统计非白像素数（每 6 行一档）==="
for($y=0;$y -lt $H;$y+=6){
  $n=0
  for($x=0;$x -lt $W;$x++){
    $c=$b.GetPixel($x,$y)
    if(-not ($c.R -gt 250 -and $c.G -gt 250 -and $c.B -gt 250)){ $n++ }
  }
  $bar = '#' * [Math]::Min(60,[int]($n/4))
  Write-Output ("  y={0,4} n={1,3} {2}" -f $y,$n,$bar)
}

Write-Output ""
Write-Output "=== 高饱和（彩色）像素的分布 —— 找品牌色块 ==="
for($x=0;$x -lt $W;$x+=4){
  $n=0;$satMax=0
  for($y=0;$y -lt $H;$y++){
    $c=$b.GetPixel($x,$y)
    $s=[Math]::Max($c.R,[Math]::Max($c.G,$c.B))-[Math]::Min($c.R,[Math]::Min($c.G,$c.B))
    if($s -gt 50){ $n++ }
    if($s -gt $satMax){$satMax=$s}
  }
  if($n -gt 0){ Write-Output ("  x={0,4} 高饱和像素 n={1,4}  该列最大饱和度={2}" -f $x,$n,$satMax) }
}
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
