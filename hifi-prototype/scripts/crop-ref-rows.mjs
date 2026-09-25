/**
 * 参考图「线程页签行」放大 —— 对照另一处"选中/未选中"控件。
 *
 * 用户报的是输入区工具条那一排（任务/讨论 + 芯片）。
 * 这里把参考图同一水平带（线程子视图页签：回复/成果/活动/成员…）也裁出来，
 * 用于确认参考图里"选中项"到底长什么样（有没有浅渐变底）。
 */

import { execFileSync } from 'node:child_process';

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

function crop(dst, x, y, w, h, s) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$src=[System.Drawing.Bitmap]::FromFile('${REF}')`,
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

crop('screenshots-visual/ref-threadtabs.png', 248, 158, 440, 42, 6);
crop('screenshots-visual/ref-contenttabs.png', 240, 68, 470, 34, 6);
console.log('ok');
