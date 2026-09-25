/**
 * 参考图「任务 / 讨论」两段文字各自的颜色。
 *
 * 从 10× 放大图可看出：参考图里这个控件**没有灰色槽、也没有白色激活块**，
 * 就是两个纯文字标签，靠**文字颜色**区分选中：
 *   「# 任务」偏蓝   「○ 讨论」偏灰
 *
 * 本脚本分别统计两段文字区域内"最深/最蓝"的像素，量化这个判断。
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

const ps = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
$b=[System.Drawing.Bitmap]::FromFile('${REF}')

function Analyse($x0,$x1,$y0,$y1,$label){
  Write-Output ("--- {0}  (x={1}..{2}, y={3}..{4}) ---" -f $label,$x0,$x1,$y0,$y1)
  $n=0; $sr=0;$sg=0;$sb=0
  $bluest=0;$bluestHex=''
  $darkest=9999;$darkestHex=''
  $bg=0
  for($y=$y0;$y -le $y1;$y++){
    for($x=$x0;$x -le $x1;$x++){
      $c=$b.GetPixel($x,$y)
      # 只统计"墨迹"像素：明显偏离白底
      if($c.R -lt 225 -or $c.G -lt 225 -or $c.B -lt 225){
        $n++; $sr+=$c.R;$sg+=$c.G;$sb+=$c.B
        $blueness = $c.B - $c.R
        if($blueness -gt $bluest){ $bluest=$blueness; $bluestHex=Hex $c }
        $lum = $c.R+$c.G+$c.B
        if($lum -lt $darkest){ $darkest=$lum; $darkestHex=Hex $c }
      }
    }
  }
  if($n -eq 0){ Write-Output "  (无墨迹像素)"; return }
  Write-Output ("  墨迹像素 n={0}  平均 #{1:x2}{2:x2}{3:x2}" -f $n,[int]($sr/$n),[int]($sg/$n),[int]($sb/$n))
  Write-Output ("  最蓝像素 {0} (B-R={1})   最深像素 {2}" -f $bluestHex,$bluest,$darkestHex)
}

# 从 10x 放大图目测：任务在左、讨论在中
Analyse 274 332 824 846 '「# 任务」'
Analyse 336 388 824 846 '「○ 讨论」'
Analyse 392 408 824 846 '回形针图标'
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }));
