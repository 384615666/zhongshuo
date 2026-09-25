/**
 * 参考图与实现的局部裁剪对照（诊断用）。
 *
 * 规范 §1.2 要求"实现选中态时对照 approved-selected-gradient.png 验收"，
 * 而 110×40 的基准图直接看缩略图会失真，必须放大后逐块比对。
 *
 * 用法：node scripts/crop-refs.mjs
 */

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'screenshots-visual');
const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';
const GRAD = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\approved-selected-gradient.png';

/**
 * 用 `-ArgumentList` 传参（不要用逗号内联，PowerShell 会把 `1500,200`
 * 当成两个位置参数，报 "A positional parameter cannot be found"）。
 */
function crop(src, dst, x, y, w, h, scale) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$src=[System.Drawing.Bitmap]::FromFile('${src}')`,
    `$rect=New-Object System.Drawing.Rectangle -ArgumentList @(${x},${y},${w},${h})`,
    '$crop=$src.Clone($rect,$src.PixelFormat)',
    `$out=New-Object System.Drawing.Bitmap -ArgumentList @(${Math.round(w * scale)},${Math.round(h * scale)})`,
    '$g=[System.Drawing.Graphics]::FromImage($out)',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor',
    '$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half',
    '$g.DrawImage($crop,0,0,$out.Width,$out.Height)',
    `$out.Save('${dst}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose();$out.Dispose();$crop.Dispose();$src.Dispose()',
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

const jobs = [
  // 110×40 基准渐变图（选中态的直接依据）
  [GRAD, 'ref-gradient-5x', 0, 0, 110, 40, 5],
  // 参考图：线程页签行 / 侧栏选中行 / 主池与回复串整栏
  [REF, 'ref-thread-tabs', 752, 158, 300, 40, 5],
  [REF, 'ref-side-active', 8, 270, 230, 40, 4],
  [REF, 'ref-pool-area', 246, 38, 506, 834, 1],
  [REF, 'ref-thread-area', 752, 38, 620, 834, 1],
];

for (const [src, name, x, y, w, h, s] of jobs) {
  try {
    crop(src, join(out, `${name}.png`), x, y, w, h, s);
    console.log(`OK   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`);
  }
}
