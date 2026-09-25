/**
 * 参考图「所有彩色元素」清单。
 *
 * 目的：客观回答"参考图里到底哪些东西上了色"。
 * 做法：扫描全图，找**高饱和像素**，再聚类成连通块，报告每块的位置/尺寸/主色。
 * 这样就不会再对"该给哪些控件上色"产生分歧 —— 参考图里有的才做，没有的不做。
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

const ps = `
Add-Type -AssemblyName System.Drawing
$b=[System.Drawing.Bitmap]::FromFile('${REF}')
$W=$b.Width; $H=$b.Height
Write-Output ("image: {0}x{1}" -f $W,$H)

# 高饱和掩码（gradient 主按钮 / 选中态 / 头像 / 语义色）
$mask = New-Object 'bool[,]' $W,$H
$sat = New-Object 'int[,]' $W,$H
for($y=0;$y -lt $H;$y++){
  for($x=0;$x -lt $W;$x++){
    $c=$b.GetPixel($x,$y)
    $mx=[Math]::Max($c.R,[Math]::Max($c.G,$c.B)); $mn=[Math]::Min($c.R,[Math]::Min($c.G,$c.B))
    $s=$mx-$mn
    $sat[$x,$y]=$s
    # 阈值 45：能收进主按钮渐变与选中态浅渐变，排除灰/白/浅灰边框
    if($s -gt 45){ $mask[$x,$y]=$true }
  }
}

# 连通块（4 邻域，BFS 用显式栈避免递归深度）
$seen = New-Object 'bool[,]' $W,$H
$blocks = @()
for($y0=0;$y0 -lt $H;$y0++){
  for($x0=0;$x0 -lt $W;$x0++){
    if(-not $mask[$x0,$y0] -or $seen[$x0,$y0]){ continue }
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($x0,$y0)); $seen[$x0,$y0]=$true
    $minX=$x0;$maxX=$x0;$minY=$y0;$maxY=$y0;$n=0
    $sumR=0;$sumG=0;$sumB=0;$sumS=0
    while($stack.Count -gt 0){
      $p=$stack.Pop(); $px=$p[0]; $py=$p[1]
      $n++
      $c=$b.GetPixel($px,$py)
      $sumR+=$c.R; $sumG+=$c.G; $sumB+=$c.B; $sumS+=$sat[$px,$py]
      if($px -lt $minX){$minX=$px}; if($px -gt $maxX){$maxX=$px}
      if($py -lt $minY){$minY=$py}; if($py -gt $maxY){$maxY=$py}
      foreach($d in @(@(1,0),@(-1,0),@(0,1),@(0,-1))){
        $nx=$px+$d[0]; $ny=$py+$d[1]
        if($nx -ge 0 -and $nx -lt $W -and $ny -ge 0 -and $ny -lt $H -and $mask[$nx,$ny] -and -not $seen[$nx,$ny]){
          $seen[$nx,$ny]=$true; $stack.Push(@($nx,$ny))
        }
      }
    }
    # 只报面积够大的（过滤抗锯齿噪点）
    if($n -ge 60){
      $r=[int]($sumR/$n); $g=[int]($sumG/$n); $bl=[int]($sumB/$n); $s=[int]($sumS/$n)
      $blocks += [pscustomobject]@{ x=$minX; y=$minY; w=($maxX-$minX+1); h=($maxY-$minY+1); area=$n; avg=('#{0:x2}{1:x2}{2:x2}' -f $r,$g,$bl); sat=$s }
    }
  }
}
$blocks | Sort-Object -Property y,x | ForEach-Object {
  Write-Output ("  bbox x={0,4} y={0,4} w={2,3} h={3,3} area={4,6} avg={5} sat={6}" -f $_.x,$_.y,$_.w,$_.h,$_.area,$_.avg,$_.sat)
}
Write-Output ("彩色块总数: {0}" -f $blocks.Count)
$b.Dispose()
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
