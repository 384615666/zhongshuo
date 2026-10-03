# Diagnostic + fix: write Chinese chart data into slide 5 of office-deck.pptx
$ErrorActionPreference = 'Stop'
if (Get-Process POWERPNT -ErrorAction SilentlyContinue) { throw 'POWERPNT already running' }
$root = 'D:\zhongshuo\dist\desktop\preview-select'
$c = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'deck-content.json') | ConvertFrom-Json
$pp = New-Object -ComObject PowerPoint.Application
$pp.DisplayAlerts = 1
try {
  $p = $pp.Presentations.Open((Join-Path $root 'samples\office-deck.pptx'), 0, 0, 0)
  Write-Output ('opened slides=' + $p.Slides.Count)
  $slide = $p.Slides.Item(5)
  $chartShape = $null
  foreach ($sh in $slide.Shapes) { if ($sh.HasChart -eq -1) { $chartShape = $sh; break } }
  if ($null -eq $chartShape) { throw 'no chart shape on slide 5' }
  $chart = $chartShape.Chart
  try { $chart.ChartData.Activate(); Write-Output 'Activate OK' } catch { Write-Output ('Activate FAIL: ' + $_.Exception.Message) }
  try {
    $wb = $chart.ChartData.Workbook
    Write-Output ('Workbook OK sheets=' + $wb.Worksheets.Count)
    $ws = $wb.ActiveSheet
    Write-Output ('ActiveSheet OK name=' + $ws.Name)
    $cats = $c.chart.categories
    Write-Output 'before writes'
    for ($i = 0; $i -lt $cats.Count; $i++) { $ws.Range(('A' + [string]($i + 2))).Value2 = [string]$cats[$i] }
    Write-Output 'categories written'
    $cols = @('B', 'C')
    for ($s = 0; $s -lt $c.chart.series.Count; $s++) {
      $ser = $c.chart.series[$s]
      $ws.Range(($cols[$s] + '1')).Value2 = [string]$ser.name
      for ($i = 0; $i -lt $ser.values.Count; $i++) { $ws.Range(($cols[$s] + [string]($i + 2))).Value2 = [double]$ser.values[$i] }
    }
    Write-Output 'series written'
    $extra = $chart.SeriesCollection().Count
    Write-Output ('series count=' + $extra)
    if ($extra -gt $c.chart.series.Count) {
      while ($chart.SeriesCollection().Count -gt $c.chart.series.Count) { $chart.SeriesCollection($chart.SeriesCollection().Count).Delete() }
      Write-Output 'extra series deleted'
    }
    $chart.HasTitle = -1
    $chart.ChartTitle.Text = $c.chart.chartTitle
    $chart.HasLegend = -1
    $chart.Legend.Position = -4107
    Write-Output 'title/legend set'
  } catch { Write-Output ('Workbook FAIL: ' + $_.Exception.Message) }
  try { $chart.Refresh(); Write-Output 'Refresh OK' } catch { Write-Output ('Refresh n/a: ' + $_.Exception.Message) }
  $p.Save()
  $p.Slides.Item(5).Export((Join-Path $root 'ref\office\slide-05.png'), 'PNG', 1280, 720)
  Write-Output 'saved + ref re-exported'
  $p.Close()
} finally { $pp.Quit() }
