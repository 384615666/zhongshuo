/**
 * 参考图「# 任务」与「○ 讨论」两段文字的核心色（避开 ClearType 彩边）。
 *
 * 参考图带子像素抗锯齿（RGB 彩边），直接取"最蓝像素"会读到彩边伪色。
 * 做法：只统计**足够暗**的像素（亮度 < 某阈值），再取这些暗像素的中位数颜色 ——
 * 彩边像素通常偏亮，会被阈值滤掉。
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

const ps = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
$b=[System.Drawing.Bitmap]::FromFile('${REF}')

function Core($x0,$x1,$y0,$y1,$label){
  $px=New-Object System.Collections.ArrayList
  for($y=$y0;$y -le $y1;$y++){
    for($x=$x0;$x -le $x1;$x++){
      $c=$b.GetPixel($x,$y)
      $lum = 0.2126*$c.R + 0.7152*$c.G + 0.0722*$c.B
      if($lum -lt 150){ [void]$px.Add([pscustomobject]@{r=$c.R;g=$c.G;b=$c.B;lum=$lum}) }
    }
  }
  if($px.Count -eq 0){ Write-Output ("{0}: 无暗像素" -f $label); return }
  $s = $px | Sort-Object -Property lum
  # 取最暗的一半，再去平均，避开边缘过渡像素
  $half = $s | Select-Object -First ([Math]::Max(1,[int]($s.Count/2)))
  $ar=0;$ag=0;$ab=0
  foreach($p in $half){ $ar+=$p.r;$ag+=$p.g;$ab+=$p.b }
  $n=$half.Count
  $r=[int]($ar/$n);$g=[int]($ag/$n);$bl=[int]($ab/$n)
  $lum = 0.2126*$r + 0.7152*$g + 0.0722*$bl
  Write-Output ("{0,-12} 暗像素 n={1,3}  核心色 {2}  亮度 {3:N1}  B-R={4}" -f $label,$px.Count,('#{0:x2}{1:x2}{2:x2}' -f $r,$g,$bl),$lum,($bl-$r))
}

# 先用 8x 放大图目测的边界
Core 286 314 826 840 '任务'
Core 336 366 826 840 '讨论'
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }));
