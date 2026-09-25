/**
 * 决定性判定：参考图里的「发送补充」按钮是**启用**还是**禁用**？
 *
 * 背景：代码审计证明四个被点名的按钮都带 `--grad`（`audit-all-primaries.mjs` ：
 * 缺渐变 0 个）。那么用户看到的"颜色不对"，最可能是**禁用态**：
 * 规范 §7 规定 disabled = `opacity: .5`，而输入框为空时发送按钮正是 disabled，
 * 渐变被 50% 稀释成一片灰蓝 —— 观感上就是"没上色"。
 *
 * 判据：如果参考图的输入区只有 **placeholder（灰字）**，而它的发送按钮却是
 * **满饱和渐变**，那就说明参考图里"空输入 + 满色按钮"，与我们的禁用态不符。
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

const ps = `
Add-Type -AssemblyName System.Drawing
$b=[System.Drawing.Bitmap]::FromFile('${REF}')
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
function Sat($c){ $mx=[Math]::Max($c.R,[Math]::Max($c.G,$c.B)); $mn=[Math]::Min($c.R,[Math]::Min($c.G,$c.B)); return $mx-$mn }

Write-Output "=== A. 输入区文字（判断是 placeholder 灰字还是正文深字）==="
Write-Output "  参考图输入行 y≈795，x=290..560 的最深像素（正文应 < #500 亮度和）："
$darkest = 9999; $darkHex=''
for($y=788;$y -le 802;$y++){
  for($x=288;$x -le 560;$x++){
    $c=$b.GetPixel($x,$y)
    $l = $c.R + $c.G + $c.B
    if($l -lt $darkest){ $darkest=$l; $darkHex=Hex $c }
  }
}
Write-Output ("  最深像素 = {0}  亮度和 = {1}" -f $darkHex, $darkest)
Write-Output "  参考：placeholder 灰字约 #7d8b9d（和≈600+）；正文深字约 #1e2a38（和≈130）"

Write-Output ""
Write-Output "=== B. 发送按钮的饱和度（判断是否被 opacity 冲淡）==="
Write-Output "  按钮 y=821..844，x=710..790 采样："
$sum=0; $n=0; $maxSat=0
for($y=822;$y -le 843;$y+=3){
  for($x=712;$x -le 788;$x+=6){
    $c=$b.GetPixel($x,$y); $s=Sat $c
    $sum+=$s; $n++; if($s -gt $maxSat){$maxSat=$s}
  }
}
Write-Output ("  平均饱和度 = {0}  最大 = {1}" -f [int]($sum/$n), $maxSat)
Write-Output "  参考：满饱和渐变约 130-190；被 50% 白稀释后约 60-95"

Write-Output ""
Write-Output "=== C. 对照：我们自己浏览器里「禁用态」发送按钮的饱和度 ==="
Write-Output "  （离线算：--grad 端点 50% 叠白）"
Write-Output "  #2a86dd -> 50% 叠白 = #95c3ee  sat=89"
Write-Output "  #0e896d -> 50% 叠白 = #87c4b6  sat=61"
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }));
