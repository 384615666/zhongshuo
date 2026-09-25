/**
 * 用户两张截图的实际像素分析。
 *
 * 用户："你看没选中和选中的时候，颜色和我给你的截图完全不一样，
 *       选中后直接全白什么都看不见了"
 *
 * 先客观读出这两张图里到底有什么颜色，再判断他在说哪个控件。
 */

import { execFileSync } from 'node:child_process';

const S1 = 'C:\\Users\\user\\.dsh\\attachments\\v1\\objects\\01\\0178b8af655e8fc0d4740b7da8434062769051003261bd9af3c9c7e33e443218';
const S2 = 'C:\\Users\\user\\.dsh\\attachments\\v1\\objects\\fd\\fd45b4dfbb2344f74d492e81213bd571d5c047fd6edc46f0912fbcc1aae55e1d';

const ps = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
function Sat($c){ $mx=[Math]::Max($c.R,[Math]::Max($c.G,$c.B)); $mn=[Math]::Min($c.R,[Math]::Min($c.G,$c.B)); return $mx-$mn }

foreach($pair in @(@('${S1}','截图1 发送按钮'),@('${S2}','截图2 输入区右下'))){
  $b=[System.Drawing.Bitmap]::FromFile($pair[0])
  Write-Output ("=========== {0}  ({1}x{2}) ===========" -f $pair[1],$b.Width,$b.Height)

  Write-Output "  出现最多的 12 种颜色："
  $counts=@{}
  for($y=0;$y -lt $b.Height;$y++){
    for($x=0;$x -lt $b.Width;$x++){
      $h=Hex $b.GetPixel($x,$y)
      if($counts.ContainsKey($h)){ $counts[$h]++ } else { $counts[$h]=1 }
    }
  }
  $tot=$b.Width*$b.Height
  $counts.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 12 | ForEach-Object {
    Write-Output ("    {0}  x{1,6}  ({2:N1}%)" -f $_.Key,$_.Value,(100*$_.Value/$tot))
  }

  # 高饱和像素的包围盒与均值 —— 找"品牌色块"
  $minX=99999;$maxX=-1;$minY=99999;$maxY=-1;$n=0;$sr=0;$sg=0;$sb=0;$ss=0
  for($y=0;$y -lt $b.Height;$y++){
    for($x=0;$x -lt $b.Width;$x++){
      $c=$b.GetPixel($x,$y); $s=Sat $c
      if($s -gt 60){
        $n++; $sr+=$c.R;$sg+=$c.G;$sb+=$c.B;$ss+=$s
        if($x -lt $minX){$minX=$x}; if($x -gt $maxX){$maxX=$x}
        if($y -lt $minY){$minY=$y}; if($y -gt $maxY){$maxY=$y}
      }
    }
  }
  if($n -gt 0){
    Write-Output ("  高饱和(>60) 像素 n={0}  bbox x={1}..{2} y={3}..{4}" -f $n,$minX,$maxX,$minY,$maxY)
    Write-Output ("    平均色 #{0:x2}{1:x2}{2:x2}  平均饱和度 {3}" -f [int]($sr/$n),[int]($sg/$n),[int]($sb/$n),[int]($ss/$n))
  } else { Write-Output "  （无高饱和像素）" }

  # 横向中线扫描，看结构
  Write-Output "  纵向中线逐列（每 4 列取一点，只报颜色变化）："
  $midY=[int]($b.Height/2); $prev=''
  for($x=0;$x -lt $b.Width;$x+=2){
    $h=Hex $b.GetPixel($x,$midY)
    if($h -ne $prev){ Write-Output ("    x={0,4} {1}" -f $x,$h); $prev=$h }
  }
  $b.Dispose()
  Write-Output ""
}
`;

console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
