# 生成 Inno Setup 安装向导品牌图（R150）
# 用法：pwsh -NoProfile -File scripts/lib/wizard-images.ps1 -OutDir packaging/windows/branding
# 只做品牌排版（渐变、圆角卡、logo、文字），不改原 logo 比例；大图固定 164:314 比例，
# 小图固定方形。生成多档尺寸供 Inno 按 DPI 自动选择（见 WizardImageFile 文档）。
param(
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logoPath = Join-Path $repo 'logo.png'
$out = Join-Path $repo $OutDir
New-Item -ItemType Directory -Force -Path $out | Out-Null
$logo = [System.Drawing.Image]::FromFile($logoPath)

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-Large([int]$w, [int]$h, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  # 背景：清透的品牌浅色渐变
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 239, 249, 252), [System.Drawing.Color]::FromArgb(255, 219, 240, 246), 90.0)
  $g.FillRectangle($bg, $rect)

  # 两个很淡的装饰圆，让侧栏不呆板
  $soft1 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 42, 168, 224))
  $g.FillEllipse($soft1, [float]($w * 0.55), [float](-$h * 0.10), [float]($w * 1.10), [float]($w * 1.10))
  $soft2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(20, 38, 120, 199))
  $g.FillEllipse($soft2, [float](-$w * 0.55), [float]($h * 0.72), [float]($w * 1.20), [float]($w * 1.20))

  # 白色圆角卡片 + logo（原图等比，不裁剪）
  $cardX = [float]($w * 0.09); $cardY = [float]($h * 0.055)
  $cardW = [float]($w * 0.82); $cardH = [float]($h * 0.395)
  $card = New-RoundedPath $cardX $cardY $cardW $cardH ([float]($w * 0.07))
  $cardBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(248, 255, 255, 255))
  $g.FillPath($cardBrush, $card)
  $cardPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 38, 120, 199), [float]([Math]::Max(1, $w / 300)))
  $g.DrawPath($cardPen, $card)
  $pad = [float]($w * 0.05)
  $side = [Math]::Min([float]($cardW - 2 * $pad), [float]($cardH - 2 * $pad))
  $logoX = $cardX + ($cardW - $side) / 2
  $logoY = $cardY + ($cardH - $side) / 2
  $g.DrawImage($logo, [System.Drawing.RectangleF]::new($logoX, $logoY, $side, $side))

  # 标题与副标题
  $titleSize = [Math]::Max(13.0, $w * 0.105)
  $titleFont = New-Object System.Drawing.Font('Microsoft YaHei UI', $titleSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $titleColor = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 16, 42, 51))
  $tagFont = New-Object System.Drawing.Font('Microsoft YaHei UI', [Math]::Max(7.0, $w * 0.042), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $tagColor = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 75, 107, 115))
  $center = New-Object System.Drawing.StringFormat
  $center.Alignment = [System.Drawing.StringAlignment]::Center
  $center.LineAlignment = [System.Drawing.StringAlignment]::Center

  $titleRect = New-Object System.Drawing.RectangleF(0, [float]($h * 0.505), $w, [float]($titleSize * 1.6))
  $g.DrawString('众说', $titleFont, $titleColor, $titleRect, $center)
  $tagRect = New-Object System.Drawing.RectangleF(0, [float]($h * 0.605), $w, [float]($w * 0.09))
  $g.DrawString('本地多 Agent 协同工作台', $tagFont, $tagColor, $tagRect, $center)

  # 细分隔线
  $linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 38, 120, 199), [float]([Math]::Max(1, $w / 400)))
  $g.DrawLine($linePen, [float]($w * 0.30), [float]($h * 0.695), [float]($w * 0.70), [float]($h * 0.695))

  # 三个短标签
  $chipFont = New-Object System.Drawing.Font('Microsoft YaHei UI', [Math]::Max(6.5, $w * 0.034), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $chipColor = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 56, 114, 128))
  $chipRect = New-Object System.Drawing.RectangleF(0, [float]($h * 0.745), $w, [float]($w * 0.07))
  $g.DrawString('本地  ·  协作  ·  离线', $chipFont, $chipColor, $chipRect, $center)

  # 底部安装范围说明
  $footFont = New-Object System.Drawing.Font('Microsoft YaHei UI', [Math]::Max(6.0, $w * 0.028), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $footColor = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 116, 145, 153))
  $footRect = New-Object System.Drawing.RectangleF(0, [float]($h * 0.895), $w, [float]($w * 0.06))
  $g.DrawString('当前用户安装 · 无需管理员权限', $footFont, $footColor, $footRect, $center)

  $g.Dispose()
  $bmp.Save((Join-Path $out $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Draw-Small([int]$s, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [float]($s * 0.035)
  $card = New-RoundedPath $pad $pad ([float]($s - 2 * $pad)) ([float]($s - 2 * $pad)) ([float]($s * 0.22))
  $cardBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(250, 255, 255, 255))
  $g.FillPath($cardBrush, $card)
  $cardPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 38, 120, 199), [float]([Math]::Max(1, $s / 60)))
  $g.DrawPath($cardPen, $card)
  $inner = [float]($s * 0.12)
  $g.DrawImage($logo, [System.Drawing.RectangleF]::new($inner, $inner, [float]($s - 2 * $inner), [float]($s - 2 * $inner)))

  $g.Dispose()
  $bmp.Save((Join-Path $out $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

# Inno 文档的建议目标尺寸（100%–250% DPI，WizardSizePercent=110 时按最近档缩放着用）
$largeSizes = @(202, 269, 336, 403, 430, 498, 534)
foreach ($w in $largeSizes) {
  $h = [int][Math]::Round($w * 314 / 164)
  Draw-Large $w $h ('wizard-large-{0}.png' -f $w)
}
$smallSizes = @(58, 77, 97, 116, 124, 143, 159)
foreach ($s in $smallSizes) { Draw-Small $s ('wizard-small-{0}.png' -f $s) }

$logo.Dispose()
Write-Output ('wizard images written to {0}' -f $out)
