/**
 * 放大用户截图 2 的右半段 —— 确认发送按钮位置到底是"没有元素"还是"白底白字"。
 */

import { execFileSync } from 'node:child_process';

const S2 = 'C:\\Users\\user\\.dsh\\attachments\\v1\\objects\\fd\\fd45b4dfbb2344f74d492e81213bd571d5c047fd6edc46f0912fbcc1aae55e1d';
const OUT = 'D:\\zhongshuo\\hifi-prototype\\screenshots-visual';

function crop(dst, x, y, w, h, s) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$src=[System.Drawing.Bitmap]::FromFile('${S2}')`,
    `$rect=New-Object System.Drawing.Rectangle -ArgumentList @(${x},${y},${w},${h})`,
    '$crop=$src.Clone($rect,$src.PixelFormat)',
    `$out=New-Object System.Drawing.Bitmap -ArgumentList @([int](${w}*${s}),[int](${h}*${s}))`,
    '$g=[System.Drawing.Graphics]::FromImage($out)',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor',
    '$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half',
    '$g.DrawImage($crop,0,0,$out.Width,$out.Height)',
    `$out.Save('${dst}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose();$out.Dispose();$crop.Dispose();$src.Dispose()',
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

crop(`${OUT}\\shot2-right.png`, 260, 30, 131, 140, 8);
console.log('ok shot2-right');

/* 逐像素找 x=280..350 范围内是否真有暗色/彩色像素 */
const ps = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
$b=[System.Drawing.Bitmap]::FromFile('${S2}')
Write-Output "=== x=275..360 内所有'非白'像素（亮度<250）==="
$n=0
for($y=30;$y -lt 170;$y++){
  for($x=275;$x -le 360;$x++){
    $c=$b.GetPixel($x,$y)
    $lum = ($c.R+$c.G+$c.B)/3
    if($lum -lt 250){
      $n++
      if($n -le 40){ Write-Output ("  ({0,4},{1,4}) {2} lum={3:N0}" -f $x,$y,(Hex $c),$lum) }
    }
  }
}
Write-Output ("  合计非白像素 {0} 个" -f $n)
$b.Dispose()
`;
console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }));
