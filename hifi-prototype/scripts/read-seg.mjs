/**
 * 精读参考图输入区工具条最左侧（「任务 / 讨论」分段控件）。
 *
 * 用户反馈："没选中和选中的时候，颜色和我给你的截图完全不一样，
 * 选中后直接全白什么都看不见了"。
 *
 * 本脚本把该区域的**所有非白像素**列出来，反推真实配色：
 * 槽底色是什么、激活块是什么、文字什么颜色。
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

const ps = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
$b=[System.Drawing.Bitmap]::FromFile('${REF}')

Write-Output "=== A. 区域 x=258..400, y=806..852 内所有出现过的颜色（按次数排序）==="
$counts=@{}
for($y=806;$y -le 852;$y++){
  for($x=258;$x -le 400;$x++){
    $c=$b.GetPixel($x,$y); $h=Hex $c
    if($counts.ContainsKey($h)){ $counts[$h]++ } else { $counts[$h]=1 }
  }
}
$counts.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 22 | ForEach-Object {
  Write-Output ("  {0}  x{1}" -f $_.Key, $_.Value)
}

Write-Output ""
Write-Output "=== B. 逐行：该行非白像素的 x 范围（找控件上下边界）==="
for($y=806;$y -le 852;$y++){
  $xs=@()
  for($x=258;$x -le 400;$x++){
    $c=$b.GetPixel($x,$y)
    if(-not ($c.R -eq 255 -and $c.G -eq 255 -and $c.B -eq 255)){ $xs += $x }
  }
  if($xs.Count -gt 0){
    Write-Output ("  y={0,4}  n={1,3}  x={2}..{3}" -f $y,$xs.Count,$xs[0],$xs[-1])
  } else {
    Write-Output ("  y={0,4}  (全白)" -f $y)
  }
}

Write-Output ""
Write-Output "=== C. 取几行横向细扫（y=812 与 y=836，避开文字中段）==="
foreach($yy in 812,836){
  Write-Output ("  --- y=$yy ---")
  $prev=''
  for($x=258;$x -le 400;$x++){
    $c=$b.GetPixel($x,$yy); $h=Hex $c
    if($h -ne $prev){ Write-Output ("    x={0,4} {1}" -f $x,$h); $prev=$h }
  }
}
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
