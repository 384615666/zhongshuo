/**
 * 「任务 / 讨论」分段控件：参考图 vs 我们的实现，逐像素对照。
 *
 * 用户反馈："没选中和选中的时候，颜色和我给你的截图完全不一样，
 * 选中后直接全白什么都看不见了"。
 *
 * 该控件在参考图输入区工具条最左侧，是本页唯一有"选中/未选中"的控件。
 * 本脚本把参考图那一段与我们的渲染等价区域都采样出来，逐列报色。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'screenshots-visual');
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

const ps = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
function Sat($c){ $mx=[Math]::Max($c.R,[Math]::Max($c.G,$c.B)); $mn=[Math]::Min($c.R,[Math]::Min($c.G,$c.B)); return $mx-$mn }

$b=[System.Drawing.Bitmap]::FromFile('${REF}')
Write-Output "=== 参考图：工具条整行的纵向范围（x=300，找控件上下边界）==="
for($y=805;$y -le 850;$y+=2){ $c=$b.GetPixel(300,$y); Write-Output ("  y={0,4} {1} sat={2}" -f $y,(Hex $c),(Sat $c)) }

Write-Output ""
Write-Output "=== 参考图：y=820 横向扫描（找灰色槽与激活块）==="
$prev=''
for($x=262;$x -le 440;$x+=2){
  $c=$b.GetPixel($x,820); $h=Hex $c
  $kind = if($h -eq '#ffffff'){'WHITE'} elseif($h -eq '#eef4f7'){'SLOT'} else {'other'}
  if($kind -ne $prev){ Write-Output ("  x={0,4} {1}  -> {2}" -f $x,$h,$kind); $prev=$kind }
}

Write-Output ""
Write-Output "=== 参考图：y=814（控件上部，避开文字）细扫 ==="
for($x=264;$x -le 428;$x+=4){
  $c=$b.GetPixel($x,814); Write-Output ("  x={0,4} {1}" -f $x,(Hex $c))
}
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }));
