#!/usr/bin/env node
/**
 * R197 验证：Windows 通知身份图标黑块修复。
 *
 * 背景：`scripts/lib/brand-icon.ps1` 曾把 7 个尺寸的 ICO 帧全部写成 PNG 压缩帧。
 * 系统通知身份图标加载器与经典 Windows API（System.Drawing.Icon）按传统 BMP/DIB
 * 解析 ICO 帧，把 PNG 字节当 DIB 读，最终显示为黑色方块/彩色噪点。修复后 7 帧必须
 * 都是传统 DIB 帧：BITMAPINFOHEADER(40) + 32bpp BGRA 自下而上 XOR + 1bpp AND 掩码。
 *
 * 本脚本复用生产转换器 brandIco()，并做三层独立断言：
 *   1. 纯 Node 解析 ICO：目录 7 帧、帧起始非 PNG 魔数、biSize=40、biBitCount=32、
 *      biHeight=2*size、biCompression=0、帧长度=头+XOR+AND、偏移连续。
 *   2. Windows PowerShell + System.Drawing：从 ICO 取 32×32 帧保存 PNG，并与
 *      logo.png 按同一缩放管线生成的 32×32 参考图比较平均/最大像素距离。
 *      （旧 PNG-in-ICO 实测 mean=59.47 / max=220.33；DIB 帧实测 0/0，阈值可区分。）
 *   3. Electron nativeImage（node_modules/electron/dist/electron.exe，Electron 44）：
 *      加载 ICO 断言非空、尺寸为 7 帧之一、位图字节数合理、缩放到 32×32 非空。
 *
 * 只产出 ignored 的 dist/r197-icon/ 证据，不改产品代码、不联网、不安装。
 * 通过：stdout 输出 JSON 且退出 0；失败：非 0。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const repo = resolve(__dirname, '..');
const evidenceDir = join(repo, 'dist', 'r197-icon');
const FRAME_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const PIXEL_MEAN_RGB_MAX = 4; // 0-255 scale, observed 0 for a correct DIB frame
const PIXEL_MAX_RGB_MAX = 32;
const PIXEL_MEAN_ALPHA_MAX = 0.01;

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
  return Boolean(pass);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const fileSha256 = (path) => (existsSync(path) ? sha256(readFileSync(path)) : null);

/** Parse an ICO buffer and structurally validate every frame as a classic DIB frame. */
function parseAndValidateIco(bytes) {
  const frames = [];
  const header = {
    reserved: bytes.readUInt16LE(0),
    type: bytes.readUInt16LE(2),
    count: bytes.readUInt16LE(4),
  };
  check('icondir.type=1', header.type === 1, `type=${header.type}`);
  check('icondir.count=7', header.count === 7, `count=${header.count}`);
  check('icondir.reserved=0', header.reserved === 0, `reserved=${header.reserved}`);
  check('icondir.size>=118', bytes.length >= 118, `bytes=${bytes.length}`);

  let expectedOffset = 6 + 16 * header.count;
  for (let index = 0; index < header.count; index += 1) {
    const base = 6 + index * 16;
    const widthByte = bytes[base];
    const heightByte = bytes[base + 1];
    const colorCount = bytes[base + 2];
    const reserved = bytes[base + 3];
    const planes = bytes.readUInt16LE(base + 4);
    const bitCount = bytes.readUInt16LE(base + 6);
    const bytesInRes = bytes.readUInt32LE(base + 8);
    const offset = bytes.readUInt32LE(base + 12);
    const size = widthByte === 0 ? 256 : widthByte;
    const expectedSize = FRAME_SIZES[index];
    const tag = `frame[${index}] ${size}x${size}`;

    check(`${tag} directory size`, size === expectedSize && heightByte === widthByte, `dir=${widthByte}x${heightByte}`);
    check(`${tag} colorCount=0`, colorCount === 0, `colorCount=${colorCount}`);
    check(`${tag} reserved=0`, reserved === 0, `reserved=${reserved}`);
    check(`${tag} planes=1`, planes === 1, `planes=${planes}`);
    check(`${tag} directory bitCount=32`, bitCount === 32, `bitCount=${bitCount}`);
    check(`${tag} offset contiguous`, offset === expectedOffset, `offset=${offset} expected=${expectedOffset}`);
    const inBounds = offset + bytesInRes <= bytes.length && bytesInRes > 0;
    check(`${tag} bounds`, inBounds, `offset=${offset} bytesInRes=${bytesInRes} total=${bytes.length}`);
    if (!inBounds) {
      frames.push({ size, offset, bytesInRes });
      expectedOffset += bytesInRes;
      continue;
    }
    expectedOffset += bytesInRes;

    const frame = bytes.subarray(offset, offset + bytesInRes);
    const isPng = frame.length >= 4 && frame.subarray(0, 4).equals(PNG_MAGIC);
    check(`${tag} not PNG`, !isPng, `prefix=${frame.subarray(0, 8).toString('hex')}`);
    check(`${tag} DIB biSize=40`, frame.readUInt32LE(0) === 40, `biSize=${frame.readUInt32LE(0)}`);

    const xorBytes = size * size * 4;
    const andStride = Math.ceil(size / 32) * 4;
    const andBytes = andStride * size;
    const expectedLength = 40 + xorBytes + andBytes;
    const biWidth = frame.readInt32LE(4);
    const biHeight = frame.readInt32LE(8);
    const biPlanes = frame.readUInt16LE(12);
    const biBitCount = frame.readUInt16LE(14);
    const biCompression = frame.readUInt32LE(16);
    const biSizeImage = frame.readUInt32LE(20);
    check(`${tag} biWidth=size`, biWidth === size, `biWidth=${biWidth}`);
    check(`${tag} biHeight=2*size`, biHeight === size * 2, `biHeight=${biHeight}`);
    check(`${tag} biPlanes=1`, biPlanes === 1, `biPlanes=${biPlanes}`);
    check(`${tag} biBitCount=32`, biBitCount === 32, `biBitCount=${biBitCount}`);
    check(`${tag} biCompression=BI_RGB`, biCompression === 0, `biCompression=${biCompression}`);
    check(`${tag} biSizeImage=xor+and`, biSizeImage === xorBytes + andBytes, `biSizeImage=${biSizeImage} expected=${xorBytes + andBytes}`);
    check(`${tag} bytesInRes=header+xor+and`, bytesInRes === expectedLength, `bytesInRes=${bytesInRes} expected=${expectedLength}`);
    const andMask = frame.subarray(40 + xorBytes);
    check(`${tag} AND mask all zero`, andMask.length === andBytes && andMask.every((value) => value === 0), `andBytes=${andMask.length} andStride=${andStride}`);

    frames.push({
      size,
      offset,
      bytesInRes,
      biWidth,
      biHeight,
      biBitCount,
      biCompression,
      biSizeImage,
      andStride,
      prefixHex: frame.subarray(0, 8).toString('hex'),
      isPng,
    });
  }
  check('icondir total length', bytes.length === expectedOffset, `bytes=${bytes.length} expected=${expectedOffset}`);
  return { header, frames };
}

/** Windows PowerShell + System.Drawing: extract 32x32 frame and compare with logo reference. */
const PS_HELPER = String.raw`param(
  [Parameter(Mandatory=$true)][string]$IcoPath,
  [Parameter(Mandatory=$true)][string]$LogoPath,
  [Parameter(Mandatory=$true)][string]$IconPngPath,
  [Parameter(Mandatory=$true)][string]$RefPngPath,
  [int]$FrameSize = 32
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$result = [ordered]@{
  icoPath = $IcoPath; logoPath = $LogoPath; frameSize = $FrameSize;
  loaded = $false; readError = $null; iconWidth = 0; iconHeight = 0;
  bitmapSize = '0x0'; bitmapFormat = '';
  meanRgbDistance = $null; maxRgbDistance = $null; meanAlphaDistance = $null;
  centerIconArgb = $null; centerRefArgb = $null
}

try {
  $icon = [System.Drawing.Icon]::new($IcoPath, $FrameSize, $FrameSize)
  try {
    $result.loaded = $true
    $result.iconWidth = $icon.Width
    $result.iconHeight = $icon.Height
    $iconBitmap = $icon.ToBitmap()
    try {
      $result.bitmapSize = "$($iconBitmap.Width)x$($iconBitmap.Height)"
      $result.bitmapFormat = $iconBitmap.PixelFormat.ToString()
      $iconBitmap.Save($IconPngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $iconBitmap.Dispose() }
  } finally { $icon.Dispose() }
} catch {
  $result.readError = $_.Exception.Message
  $result | ConvertTo-Json -Compress
  exit 0
}

# Reference image: same scaling pipeline as scripts/lib/brand-icon.ps1, at FrameSize.
$sourceImage = [System.Drawing.Image]::FromFile($LogoPath)
$referenceBitmap = [System.Drawing.Bitmap]::new($FrameSize, $FrameSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $graphics = [System.Drawing.Graphics]::FromImage($referenceBitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $scale = [Math]::Min($FrameSize / $sourceImage.Width, $FrameSize / $sourceImage.Height)
    $drawWidth = [Math]::Max(1, [int][Math]::Round($sourceImage.Width * $scale))
    $drawHeight = [Math]::Max(1, [int][Math]::Round($sourceImage.Height * $scale))
    $rectangle = [System.Drawing.Rectangle]::new([int](($FrameSize - $drawWidth) / 2), [int](($FrameSize - $drawHeight) / 2), $drawWidth, $drawHeight)
    $graphics.DrawImage($sourceImage, $rectangle)
  } finally { $graphics.Dispose() }
  $referenceBitmap.Save($RefPngPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $compareIcon = [System.Drawing.Icon]::new($IcoPath, $FrameSize, $FrameSize).ToBitmap()
  try {
    $sum = 0.0; $max = 0.0; $alphaSum = 0.0
    $count = $FrameSize * $FrameSize
    for ($y = 0; $y -lt $FrameSize; $y++) {
      for ($x = 0; $x -lt $FrameSize; $x++) {
        $iconPixel = $compareIcon.GetPixel($x, $y)
        $refPixel = $referenceBitmap.GetPixel($x, $y)
        $iconAlpha = $iconPixel.A / 255.0; $refAlpha = $refPixel.A / 255.0
        $iconR = [int][Math]::Round($iconPixel.R * $iconAlpha + 255 * (1 - $iconAlpha))
        $iconG = [int][Math]::Round($iconPixel.G * $iconAlpha + 255 * (1 - $iconAlpha))
        $iconB = [int][Math]::Round($iconPixel.B * $iconAlpha + 255 * (1 - $iconAlpha))
        $refR = [int][Math]::Round($refPixel.R * $refAlpha + 255 * (1 - $refAlpha))
        $refG = [int][Math]::Round($refPixel.G * $refAlpha + 255 * (1 - $refAlpha))
        $refB = [int][Math]::Round($refPixel.B * $refAlpha + 255 * (1 - $refAlpha))
        $distance = ([Math]::Abs($iconR - $refR) + [Math]::Abs($iconG - $refG) + [Math]::Abs($iconB - $refB)) / 3.0
        if ($distance -gt $max) { $max = $distance }
        $sum += $distance
        $alphaSum += [Math]::Abs($iconPixel.A - $refPixel.A) / 255.0
      }
    }
    $result.meanRgbDistance = [Math]::Round($sum / $count, 4)
    $result.maxRgbDistance = [Math]::Round($max, 4)
    $result.meanAlphaDistance = [Math]::Round($alphaSum / $count, 4)
    $result.centerIconArgb = $compareIcon.GetPixel([int]($FrameSize / 2), [int]($FrameSize / 2)).ToArgb()
    $result.centerRefArgb = $referenceBitmap.GetPixel([int]($FrameSize / 2), [int]($FrameSize / 2)).ToArgb()
  } finally { $compareIcon.Dispose() }
} finally { $referenceBitmap.Dispose(); $sourceImage.Dispose() }

$result | ConvertTo-Json -Compress
`;

function lastJsonLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // keep looking for the JSON payload line
    }
  }
  return null;
}

function runDrawingCheck(icoPath, logoPath, iconPngPath, refPngPath) {
  const helperPath = join(evidenceDir, 'verify-extract.ps1');
  writeFileSync(helperPath, PS_HELPER, 'utf8');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-IcoPath', icoPath,
    '-LogoPath', logoPath,
    '-IconPngPath', iconPngPath,
    '-RefPngPath', refPngPath,
    '-FrameSize', '32',
  ], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const payload = lastJsonLine(result.stdout);
  return {
    status: result.status,
    error: result.error ? result.error.message : null,
    stderr: String(result.stderr ?? '').trim(),
    payload,
  };
}

/** Electron nativeImage loader check (must run in the Electron browser process). */
const NATIVE_IMAGE_CHECK = String.raw`'use strict';
const { app, nativeImage } = require('electron');

app.whenReady().then(() => {
  try {
    const input = process.argv[2];
    const image = nativeImage.createFromPath(input);
    const size = image.getSize();
    const result = {
      input,
      isEmpty: image.isEmpty(),
      width: size.width,
      height: size.height,
      scaleFactors: image.getScaleFactors(),
      bitmapBytes: image.toBitmap().length,
      pngBytes: image.toPNG().length,
    };
    try {
      const resized = image.resize({ width: 32, height: 32, quality: 'best' });
      result.resized = {
        width: resized.getSize().width,
        height: resized.getSize().height,
        isEmpty: resized.isEmpty(),
      };
    } catch (error) {
      result.resizeError = error && error.message ? error.message : String(error);
    }
    process.stdout.write(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error));
    app.exit(1);
  }
});
`;

function runNativeImageCheck(icoPath) {
  const scriptPath = join(evidenceDir, 'native-image-check.cjs');
  writeFileSync(scriptPath, NATIVE_IMAGE_CHECK, 'utf8');
  const electronExe = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!existsSync(electronExe)) throw new Error(`Electron executable missing: ${electronExe}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // a browser process is required for the app/nativeImage API
  const result = spawnSync(electronExe, [scriptPath, icoPath], {
    encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024, env,
  });
  const payload = lastJsonLine(result.stdout);
  return {
    status: result.status,
    error: result.error ? result.error.message : null,
    stderr: String(result.stderr ?? '').trim(),
    payload,
  };
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error(`R197 brand-icon verification targets Windows only; platform=${process.platform}`);
  }
  mkdirSync(evidenceDir, { recursive: true });

  const logoPath = join(repo, 'logo.png');
  check('logo.png exists', existsSync(logoPath), logoPath);

  // 1. Production converter: brandIco() keeps its contract and now emits DIB frames.
  const { brandIco, brandIconName } = await import(pathToFileURL(join(repo, 'scripts', 'lib', 'brand-icon.mjs')).href);
  const icoBytes = brandIco(logoPath);
  const icoPath = join(evidenceDir, 'r197-brand.ico');
  writeFileSync(icoPath, icoBytes);
  check('brandIco() bytes > 0', icoBytes.length > 0, `bytes=${icoBytes.length}`);
  check('brandIconName() is Zhongshuo-<hash>.ico', /^Zhongshuo-[0-9a-f]{12}\.ico$/.test(brandIconName(icoBytes)), brandIconName(icoBytes));

  const parsed = parseAndValidateIco(icoBytes);
  check('frames parsed = 7', parsed.frames.length === 7, `frames=${parsed.frames.length}`);

  // 2. System.Drawing extraction: the 32x32 frame must be the logo, not noise.
  const iconPngPath = join(evidenceDir, 'frame-32-extracted.png');
  const refPngPath = join(evidenceDir, 'frame-32-reference.png');
  const drawing = runDrawingCheck(icoPath, logoPath, iconPngPath, refPngPath);
  check('System.Drawing run exit=0', drawing.status === 0 && !drawing.error, `status=${drawing.status} error=${drawing.error} stderr=${drawing.stderr}`);
  const pixels = drawing.payload;
  check('System.Drawing payload JSON', pixels != null, drawing.payload == null ? 'no JSON payload' : 'ok');
  if (pixels != null) {
    check('System.Drawing icon loaded', pixels.loaded === true, `loaded=${pixels.loaded} readError=${pixels.readError}`);
    check('System.Drawing icon bitmap 32x32', pixels.bitmapSize === '32x32', `bitmapSize=${pixels.bitmapSize} format=${pixels.bitmapFormat}`);
    check('System.Drawing icon bitmap 32bpp', /32bpp/.test(String(pixels.bitmapFormat)), `format=${pixels.bitmapFormat}`);
    check(`mean RGB distance <= ${PIXEL_MEAN_RGB_MAX}`, pixels.meanRgbDistance != null && pixels.meanRgbDistance <= PIXEL_MEAN_RGB_MAX, `meanRgbDistance=${pixels.meanRgbDistance} (PNG-in-ICO control observed 59.4652)`);
    check(`max RGB distance <= ${PIXEL_MAX_RGB_MAX}`, pixels.maxRgbDistance != null && pixels.maxRgbDistance <= PIXEL_MAX_RGB_MAX, `maxRgbDistance=${pixels.maxRgbDistance} (PNG-in-ICO control observed 220.3333)`);
    check(`mean alpha distance <= ${PIXEL_MEAN_ALPHA_MAX}`, pixels.meanAlphaDistance != null && pixels.meanAlphaDistance <= PIXEL_MEAN_ALPHA_MAX, `meanAlphaDistance=${pixels.meanAlphaDistance}`);
    check('center pixel matches logo reference', pixels.centerIconArgb === pixels.centerRefArgb, `icon=${pixels.centerIconArgb} ref=${pixels.centerRefArgb}`);
  }
  check('extracted PNG exists', existsSync(iconPngPath) && statSync(iconPngPath).size > 0, iconPngPath);
  check('reference PNG exists', existsSync(refPngPath) && statSync(refPngPath).size > 0, refPngPath);

  // 3. Electron nativeImage must still accept the ICO (Electron decodes both PNG and DIB frames).
  const nativeCheck = runNativeImageCheck(icoPath);
  check('Electron nativeImage run exit=0', nativeCheck.status === 0 && !nativeCheck.error, `status=${nativeCheck.status} error=${nativeCheck.error} stderr=${nativeCheck.stderr}`);
  const nativeImage = nativeCheck.payload;
  check('Electron nativeImage payload JSON', nativeImage != null, nativeImage == null ? 'no JSON payload' : 'ok');
  if (nativeImage != null) {
    check('nativeImage not empty', nativeImage.isEmpty === false, `isEmpty=${nativeImage.isEmpty}`);
    const validSize = Number.isInteger(nativeImage.width)
      && nativeImage.width === nativeImage.height
      && FRAME_SIZES.includes(nativeImage.width)
      && nativeImage.width >= 32;
    check('nativeImage size is one of the 7 frames', validSize, `size=${nativeImage.width}x${nativeImage.height} scaleFactors=${JSON.stringify(nativeImage.scaleFactors)}`);
    check('nativeImage bitmap bytes = width*height*4', nativeImage.bitmapBytes === nativeImage.width * nativeImage.height * 4, `bitmapBytes=${nativeImage.bitmapBytes} expected=${nativeImage.width * nativeImage.height * 4}`);
    check('nativeImage resize 32x32 not empty', nativeImage.resized != null && nativeImage.resized.isEmpty === false && nativeImage.resized.width === 32 && nativeImage.resized.height === 32, JSON.stringify(nativeImage.resized));
  }

  const failures = checks.filter((entry) => !entry.pass);
  const reportPath = join(evidenceDir, 'verify-report.json');
  const summary = {
    pass: failures.length === 0,
    round: 'R197',
    script: 'scripts/verify-brand-icon-r197.cjs',
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    expectedFrameSizes: FRAME_SIZES,
    thresholds: {
      meanRgbDistanceMax: PIXEL_MEAN_RGB_MAX,
      maxRgbDistanceMax: PIXEL_MAX_RGB_MAX,
      meanAlphaDistanceMax: PIXEL_MEAN_ALPHA_MAX,
      pngInIcoControl: { meanRgbDistance: 59.4652, maxRgbDistance: 220.3333 },
    },
    artifact: {
      ico: icoPath,
      icoBytes: icoBytes.length,
      icoSha256: sha256(icoBytes),
      pairs: parsed.frames.map((frame) => ({
        size: frame.size,
        directoryByte: frame.size === 256 ? 0 : frame.size,
        offset: frame.offset,
        bytesInRes: frame.bytesInRes,
        biWidth: frame.biWidth,
        biHeight: frame.biHeight,
        biBitCount: frame.biBitCount,
        biCompression: frame.biCompression,
        biSizeImage: frame.biSizeImage,
        andStride: frame.andStride,
        prefixHex: frame.prefixHex,
        pngMagic: frame.isPng,
      })),
      extracted32Png: { path: iconPngPath, sha256: fileSha256(iconPngPath) },
      reference32Png: { path: refPngPath, sha256: fileSha256(refPngPath) },
    },
    pixel: pixels,
    nativeImage,
    checkCount: checks.length,
    checks,
    failures: failures.map((entry) => entry.name),
    evidenceDir,
    report: reportPath,
  };
  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  // stdout: compact console summary; the complete 7-frame/check-by-check report is the JSON file above.
  const consoleSummary = {
    pass: summary.pass,
    round: summary.round,
    generatedAt: summary.generatedAt,
    checkCount: summary.checkCount,
    failedChecks: failures.map((entry) => ({ name: entry.name, detail: entry.detail })),
    thresholds: summary.thresholds,
    ico: {
      path: summary.artifact.ico,
      bytes: summary.artifact.icoBytes,
      sha256: summary.artifact.icoSha256,
      frames: summary.artifact.pairs.map((frame) => `${frame.size}px DIB(${frame.prefixHex.slice(0, 8)}) bytes=${frame.bytesInRes}`),
    },
    pixel: summary.pixel,
    nativeImage: summary.nativeImage,
    evidenceDir: summary.evidenceDir,
    report: reportPath,
  };
  process.stdout.write(`${JSON.stringify(consoleSummary, null, 2)}\n`);
  return summary.pass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
