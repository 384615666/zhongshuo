param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$sourceImage = [System.Drawing.Image]::FromFile($Source)
$output = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($output)
try {
    # ICO frames are traditional BMP/DIB images (BITMAPINFOHEADER + 32bpp BGRA XOR
    # bitmap + 1bpp AND mask), never PNG streams: the Windows notification identity
    # icon loader and the legacy System.Drawing.Icon API parse ICO frames as DIBs and
    # render PNG-compressed frames as garbage (user-visible black square in toasts).
    $sizes = @(16, 24, 32, 48, 64, 128, 256)
    $frames = @()
    foreach ($size in $sizes) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $scale = [Math]::Min($size / $sourceImage.Width, $size / $sourceImage.Height)
            $width = [Math]::Max(1, [int][Math]::Round($sourceImage.Width * $scale))
            $height = [Math]::Max(1, [int][Math]::Round($sourceImage.Height * $scale))
            $rectangle = [System.Drawing.Rectangle]::new([int](($size - $width) / 2), [int](($size - $height) / 2), $width, $height)
            $graphics.DrawImage($sourceImage, $rectangle)
        } finally { $graphics.Dispose() }
        try {
            # Copy the rendered BGRA pixels out of GDI+ (top-down rows).
            $lockRectangle = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
            $locked = $bitmap.LockBits($lockRectangle, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            try {
                $stride = [Math]::Abs($locked.Stride)
                $pixels = [byte[]]::new($stride * $size)
                [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $pixels, 0, $pixels.Length)
                $topDown = $locked.Stride -gt 0
            } finally { $bitmap.UnlockBits($locked) }
        } finally { $bitmap.Dispose() }
        $rowBytes = $size * 4
        # DIB rows are 4-byte aligned; the AND mask is 1bpp (width bits -> ceil/8 bytes -> 4-aligned).
        $maskStride = [int]([Math]::Floor(($size + 31) / 32) * 4)
        $xorSize = $rowBytes * $size
        $andSize = $maskStride * $size
        $frame = [System.IO.MemoryStream]::new()
        $frameWriter = [System.IO.BinaryWriter]::new($frame)
        try {
            # BITMAPINFOHEADER: biHeight is doubled for ICO (XOR bitmap + AND mask).
            $frameWriter.Write([uint32]40)
            $frameWriter.Write([int32]$size)
            $frameWriter.Write([int32]($size * 2))
            $frameWriter.Write([uint16]1)
            $frameWriter.Write([uint16]32)
            $frameWriter.Write([uint32]0)
            $frameWriter.Write([uint32]($xorSize + $andSize))
            $frameWriter.Write([int32]0)
            $frameWriter.Write([int32]0)
            $frameWriter.Write([uint32]0)
            $frameWriter.Write([uint32]0)
            # XOR bitmap: 32bpp BGRA rows from bottom to top.
            for ($row = $size - 1; $row -ge 0; $row--) {
                $offset = if ($topDown) { $row * $stride } else { ($size - 1 - $row) * $stride }
                $frameWriter.Write($pixels, $offset, $rowBytes)
            }
            # AND mask: all zero bits = opaque; the alpha channel carries transparency.
            $frameWriter.Write([byte[]]::new($andSize))
            $frameWriter.Flush()
            $frames += ,$frame.ToArray()
        } finally { $frameWriter.Dispose(); $frame.Dispose() }
    }
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($index = 0; $index -lt $sizes.Count; $index++) {
        $dimension = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$index].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$index].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
    $writer.Flush()
    [Console]::Out.Write([Convert]::ToBase64String($output.ToArray()))
} finally { $sourceImage.Dispose(); $writer.Dispose(); $output.Dispose() }
