/**
 * 决定性判定：参考图的「任务」后面到底有没有"选中底"？
 *
 * 用户反馈该控件"颜色和截图完全不一样，选中后直接全白什么都看不见"。
 * 关键分歧：规范 §5.5 要求"槽 --bg-surface-3 + 激活块白底"，
 * 而之前肉眼看参考图似乎只是纯文字。必须用像素判定。
 *
 * 做法：分别统计「任务」与「讨论」**文字周围区域**的底色像素
 * （排除墨迹与纯白），比较两者的"蓝味"(B-R) 与亮度。
 * 若「任务」区域存在大面积浅蓝底（B-R>4 且亮度>240），说明参考图用的是
 * **浅渐变选中底**（与导航项/页签同一套），而不是白块。
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

const ps = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
$b=[System.Drawing.Bitmap]::FromFile('${REF}')

function BgTint($x0,$x1,$y0,$y1,$label){
  $n=0;$sr=0;$sg=0;$sb=0
  $tinted=0
  for($y=$y0;$y -le $y1;$y++){
    for($x=$x0;$x -le $x1;$x++){
      $c=$b.GetPixel($x,$y)
      $lum = 0.2126*$c.R + 0.7152*$c.G + 0.0722*$c.B
      # 只取"浅色底"像素：够亮（排除文字），又不是纯白
      if($lum -gt 225 -and -not ($c.R -eq 255 -and $c.G -eq 255 -and $c.B -eq 255)){
        $n++; $sr+=$c.R;$sg+=$c.G;$sb+=$c.B
        if(($c.B - $c.R) -gt 4){ $tinted++ }
      }
    }
  }
  $area = ($x1-$x0+1)*($y1-$y0+1)
  if($n -eq 0){ Write-Output ("{0,-10} 无浅色底像素（区域全白或全墨）" -f $label); return }
  $r=[int]($sr/$n);$g=[int]($sg/$n);$bl=[int]($sb/$n)
  $pctN = 100*$n/$area
  $pctT = 100*$tinted/$n
  $line = "{0,-10} 浅底像素 n={1,4}/{2,4} ({3:N1}%)  平均 #{4:x2}{5:x2}{6:x2}  B-R={7}  B-R大于4 的占 {8:N1}%" -f $label,$n,$area,$pctN,$r,$g,$bl,($bl-$r),$pctT
  Write-Output $line
}

Write-Output "=== 比较「任务」与「讨论」周围的底色 ==="
BgTint 272 334 820 850 '任务'
BgTint 334 392 820 850 '讨论'
Write-Output ""
Write-Output "=== 对照：已知的浅渐变选中态基准图 approved-selected-gradient.png ==="
$g=[System.Drawing.Bitmap]::FromFile('D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\approved-selected-gradient.png')
Write-Output ("  该图 110x40，x=60,y=6 处 = {0}（渐变中段）" -f (Hex $g.GetPixel(60,6)))
Write-Output ("  x=20,y=6 = {0}   x=95,y=6 = {1}" -f (Hex $g.GetPixel(20,6)),(Hex $g.GetPixel(95,6)))
$g.Dispose()
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }));
