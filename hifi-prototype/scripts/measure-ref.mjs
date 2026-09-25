/**
 * 参考图精确测量（诊断用）。
 *
 * 目的：把用户两张参考图里**关键控件的真实像素值**测出来，
 * 而不是靠看缩略图猜。用户已明确三处不符，需要可对照的数值。
 *
 * 用法：node scripts/measure-ref.mjs
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';
const GRAD = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\approved-selected-gradient.png';

function run(ps) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return out.trim();
}

const header = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
`;

/* ---------- 1. 110x40 基准渐变：逐列取中位色，得到左→右真实端点 ---------- */
const gradScan = run(`${header}
$b=[System.Drawing.Bitmap]::FromFile('${GRAD}')
Write-Output ("size {0}x{1}" -f $b.Width,$b.Height)
# 纵向中线扫一遍，跳过图形与文字（只取"纯背景"列）
foreach ($x in 6,10,16,22,28,34,40,70,80,88,94,100,104) {
  $c=$b.GetPixel($x,8)
  Write-Output ("x={0,3} {1}" -f $x,(Hex $c))
}
# 四角与中心（判断圆角半径）
Write-Output "--- corners (alpha at 1..8 px inset) ---"
foreach ($i in 0,1,2,3,4,6,8,10) {
  $c=$b.GetPixel($i,0); Write-Output ("top y=0 x={0,2} {1}" -f $i,(Hex $c))
}
$b.Dispose()
`);
console.log('=== approved-selected-gradient.png (110x40) ===');
console.log(gradScan);

/* ---------- 2. 参考图：线程列 vs 文件预览列的底色 ---------- */
const bgScan = run(`${header}
$b=[System.Drawing.Bitmap]::FromFile('${REF}')
Write-Output ("size {0}x{1}" -f $b.Width,$b.Height)
Write-Output "--- 竖向扫描：x=760(线程列右缘空白) / x=1340(文件列右缘空白) ---"
foreach ($y in 60,100,200,300,400,500,600,700,760,800,840) {
  $a=$b.GetPixel(760,$y); $c=$b.GetPixel(1340,$y)
  Write-Output ("y={0,3}  thread={1}  file={2}" -f $y,(Hex $a),(Hex $c))
}
Write-Output "--- 线程列内部空白（避开卡片）x=740 ---"
foreach ($y in 100,150,230,300,420,470,560,640,700,740,780,820) {
  $c=$b.GetPixel(740,$y); Write-Output ("y={0,3} {1}" -f $y,(Hex $c))
}
$b.Dispose()
`);
console.log('\n=== kimi-clean-layout-reference.png — 列底色 ===');
console.log(bgScan);

/* ---------- 3. 参考图：发送按钮区域 ---------- */
const btnScan = run(`${header}
$b=[System.Drawing.Bitmap]::FromFile('${REF}')
Write-Output "--- 发送按钮（中列右下）扫 y=805..835, x=690..750 ---"
foreach ($y in 806,812,818,824,830) {
  $row="y={0,3} " -f $y
  foreach ($x in 690,700,710,720,730,740,748) { $row += "{0,9}" -f (Hex $b.GetPixel($x,$y)) }
  Write-Output $row
}
Write-Output "--- 线程列页签行：找浅渐变 pill（y=160..200, x=756..1050）---"
foreach ($y in 164,172,180,188,196) {
  $row="y={0,3} " -f $y
  foreach ($x in 756,766,778,790,806,822,850,890,940,1000) { $row += "{0,9}" -f (Hex $b.GetPixel($x,$y)) }
  Write-Output $row
}
$b.Dispose()
`);
console.log('\n=== kimi-clean-layout-reference.png — 按钮与页签 ===');
console.log(btnScan);
