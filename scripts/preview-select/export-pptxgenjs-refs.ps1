# Round 40 Block D1: verify PptxGenJS sample is Office-openable + export per-slide reference PNGs
$ErrorActionPreference = 'Stop'
$root = 'D:\zhongshuo\dist\desktop\preview-select'
$dir = Join-Path $root 'ref\pptxgenjs-tables'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
if (Get-Process POWERPNT -ErrorAction SilentlyContinue) { throw 'POWERPNT already running' }
$pp = New-Object -ComObject PowerPoint.Application
$pp.DisplayAlerts = 1
try {
  $p = $pp.Presentations.Open((Join-Path $root 'samples\pptxgenjs-tables.pptx'), -1, 0, 0)
  Write-Output ('opened slides=' + $p.Slides.Count)
  for ($i = 1; $i -le $p.Slides.Count; $i++) {
    $p.Slides.Item($i).Export((Join-Path $dir ('slide-{0:D2}.png' -f $i)), 'PNG', 1280, 720)
  }
  $p.Close()
  Write-Output '[pptxgenjs-refs] OK'
} finally { $pp.Quit() }
