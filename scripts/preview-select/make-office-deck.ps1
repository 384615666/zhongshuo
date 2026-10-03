# Preview selection eval (2026-10-03): author a REAL Office-saved PPTX sample deck
# and export per-slide reference PNGs via PowerPoint COM (Office 2007 build 12.1).
# ASCII-only script: all Chinese content is read from deck-content.json (UTF-8).
# Outputs -> dist/desktop/preview-select/samples + /ref ; result JSON -> root.

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) 'dist\desktop\preview-select'
$samplesDir = Join-Path $outRoot 'samples'
$refDir = Join-Path $outRoot 'ref\office'
New-Item -ItemType Directory -Force -Path $refDir | Out-Null

if (Get-Process POWERPNT -ErrorAction SilentlyContinue) { throw 'POWERPNT already running; aborting to avoid touching user session.' }

$content = Get-Content -Raw -Encoding UTF8 (Join-Path $scriptDir 'deck-content.json') | ConvertFrom-Json
$result = [ordered]@{}

function Rgb([int]$r, [int]$g, [int]$b) { return $r + $g * 256 + $b * 65536 }

$pp = New-Object -ComObject PowerPoint.Application
$pp.DisplayAlerts = 1  # ppAlertsNone
try {
  $pres = $pp.Presentations.Add(-1)
  $pres.PageSetup.SlideWidth = 960
  $pres.PageSetup.SlideHeight = 540

  # Non-default theme (best effort; master edits below also create inheritance pressure)
  $result.themeApplied = $false
  try { $pres.ApplyTemplate($content.themePath); $result.themeApplied = $true } catch { $result.themeApplied = $false }

  # Master edit: title placeholder font + color (slides must inherit these)
  $titlePh = $pres.SlideMaster.Shapes.Placeholders.Item(1)
  $titlePh.TextFrame.TextRange.Font.Name = 'Georgia'
  $titlePh.TextFrame.TextRange.Font.NameFarEast = 'KaiTi'
  $titlePh.TextFrame.TextRange.Font.Color.RGB = Rgb 140 30 30

  function Set-Title($slide, $text) {
    $slide.Shapes.Title.TextFrame.TextRange.Text = $text
  }
  function Add-PageTag($slide, [int]$n, [int]$total) {
    $tb = $slide.Shapes.AddTextbox(1, 870, 8, 80, 26)
    $tb.TextFrame.TextRange.Text = ('p{0}/{1}' -f $n, $total)
    $tb.TextFrame.TextRange.Font.Size = 11
    $tb.TextFrame.TextRange.Font.Color.RGB = Rgb 128 128 128
    $tb.Name = ('pageTag{0}' -f $n)
  }
  function Set-Notes($slide, $text) {
    $slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = $text
  }

  # --- slide 1: cover (title layout), mixed-font subtitle runs
  $s1 = $pres.Slides.Add(1, 1)
  Set-Title $s1 $content.deckTitle
  $sub = $s1.Shapes.Placeholders.Item(2)
  $all = ($content.subtitleRuns | ForEach-Object { $_.text }) -join ''
  $sub.TextFrame.TextRange.Text = $all
  $pos = 1
  foreach ($run in $content.subtitleRuns) {
    $len = $run.text.Length
    $seg = $sub.TextFrame.TextRange.Characters($pos, $len)
    $seg.Font.Name = $run.font; $seg.Font.NameFarEast = $run.font
    $seg.Font.Size = $run.size; $seg.Font.Bold = $(if ($run.bold) { -1 } else { 0 })
    $pos += $len
  }
  Set-Notes $s1 $content.notes.'1'
  Add-PageTag $s1 1 8

  # --- slide order probe: author picture page BEFORE dense page, then reorder via MoveTo
  $s3 = $pres.Slides.Add(2, 2)  # position 2 for now; final position 3
  Set-Title $s3 $content.picture.title
  $pic = $s3.Shapes.AddPicture((Join-Path $samplesDir 'assets\embed-pic.png'), 0, -1, 300, 160, 320, 200)
  $pic.Line.Weight = 1.5; $pic.Line.ForeColor.RGB = Rgb 60 60 60
  $cap3 = $s3.Shapes.AddTextbox(1, 60, 420, 700, 40)
  $cap3.TextFrame.TextRange.Text = $content.picture.caption
  Set-Notes $s3 $content.notes.'3'
  Add-PageTag $s3 3 8

  $s2 = $pres.Slides.Add(3, 2)  # position 3 for now; final position 2
  Set-Title $s2 $content.dense.title
  $body = $s2.Shapes.Placeholders.Item(2)
  $lines = @()
  foreach ($p in $content.dense.paras) {
    $parts = $p -split "`n"
    $i = 0
    foreach ($part in $parts) { $lines += ,@($part, $i); $i = 1 }  # after first \n -> sub level
  }
  $body.TextFrame.TextRange.Text = ($lines | ForEach-Object { $_[0] }) -join "`r"
  $sizes = @(16, 14, 14, 16, 14); $bolds = @($false, $false, $true, $false, $false)
  # map each output paragraph to (size,bold) from its source paragraph index
  $srcIdx = 0; $mapping = @()
  foreach ($p in $content.dense.paras) {
    $parts = ($p -split "`n").Count
    for ($k = 0; $k -lt $parts; $k++) { $mapping += $srcIdx }
    $srcIdx++
  }
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $para = $body.TextFrame.TextRange.Paragraphs($i + 1)
    $si = $mapping[$i]
    $para.Font.Size = $sizes[$si]
    $para.Font.Bold = $(if ($bolds[$si]) { -1 } else { 0 })
    if ($lines[$i][1] -eq 1) { $para.IndentLevel = 2 }
  }
  Set-Notes $s2 $content.notes.'2'
  Add-PageTag $s2 2 8

  $pres.Slides.Item(3).MoveTo(2)  # final order: cover, dense(2), picture(3)
  $result.orderProbe = 'created picture-before-dense then MoveTo(2)'

  # --- slide 4: table
  $s4 = $pres.Slides.Add(4, 2)
  Set-Title $s4 $content.table.title
  $tblShape = $s4.Shapes.AddTable(5, 4, 80, 150, 800, 300)
  $tbl = $tblShape.Table
  for ($col = 1; $col -le 4; $col++) {
    $cell = $tbl.Cell(1, $col)
    $cell.Shape.TextFrame.TextRange.Text = $content.table.header[$col - 1]
    $cell.Shape.TextFrame.TextRange.Font.Bold = -1
    $cell.Shape.Fill.ForeColor.RGB = Rgb 221 235 247
  }
  for ($row = 2; $row -le 5; $row++) {
    for ($col = 1; $col -le 4; $col++) {
      $tbl.Cell($row, $col).Shape.TextFrame.TextRange.Text = [string]$content.table.rows[$row - 2][$col - 1]
    }
  }
  Set-Notes $s4 $content.notes.'4'
  Add-PageTag $s4 4 8

  # --- slide 5: column chart with Chinese data via embedded workbook
  $s5 = $pres.Slides.Add(5, 2)
  Set-Title $s5 $content.chart.title
  $result.chartMode = 'failed'
  try {
    $chartShape = $s5.Shapes.AddChart(51, 100, 140, 760, 360)  # xlColumnClustered
    $chart = $chartShape.Chart
    try {
      $chart.ChartData.Activate()
      $wb = $chart.ChartData.Workbook
      $ws = $wb.ActiveSheet
      $cats = $content.chart.categories
      $cols = @('B', 'C')
      for ($i = 0; $i -lt $cats.Count; $i++) { $ws.Range(('A' + [string]($i + 2))).Value2 = [string]$cats[$i] }
      for ($s = 0; $s -lt $content.chart.series.Count; $s++) {
        $ser = $content.chart.series[$s]
        $ws.Range(($cols[$s] + '1')).Value2 = [string]$ser.name
        for ($i = 0; $i -lt $ser.values.Count; $i++) { $ws.Range(($cols[$s] + [string]($i + 2))).Value2 = [double]$ser.values[$i] }
      }
      while ($chart.SeriesCollection().Count -gt $content.chart.series.Count) {
        $chart.SeriesCollection($chart.SeriesCollection().Count).Delete()
      }
      try { $chart.SetSourceData($ws.Range('A1:C5')) } catch { try { $chart.Refresh() } catch {} }
      try { $wb.Close($false) } catch {}
      $result.chartMode = 'workbook'
    } catch { $result.chartMode = 'default-data' }
    $chart.HasTitle = -1
    $chart.ChartTitle.Text = $content.chart.chartTitle
    $chart.HasLegend = -1
    $chart.Legend.Position = -4107  # xlLegendPositionBottom
  } catch { $result.chartMode = ('addchart-failed: ' + $_.Exception.Message) }
  Set-Notes $s5 $content.notes.'5'
  Add-PageTag $s5 5 8

  # --- slide 6: grouped shapes with theme fills, rotated
  $s6 = $pres.Slides.Add(6, 2)
  Set-Title $s6 $content.group.title
  $r1 = $s6.Shapes.AddShape(1, 120, 170, 240, 140);  $r1.Name = 'grpRect'    # rectangle
  $r2 = $s6.Shapes.AddShape(9, 400, 170, 200, 140);  $r2.Name = 'grpOval'    # oval
  $r3 = $s6.Shapes.AddShape(33, 640, 220, 160, 60);  $r3.Name = 'grpArrow'   # right arrow
  $grp = $s6.Shapes.Range(@('grpRect', 'grpOval', 'grpArrow')).Group()
  $grp.Rotation = 15
  $cap6 = $s6.Shapes.AddTextbox(1, 60, 430, 700, 40)
  $cap6.TextFrame.TextRange.Text = $content.group.caption
  Set-Notes $s6 $content.notes.'6'
  Add-PageTag $s6 6 8

  # --- slide 7: master/theme inheritance (no run-level fonts on this page)
  $s7 = $pres.Slides.Add(7, 2)
  Set-Title $s7 $content.theme.title
  $th7 = $s7.Shapes.AddShape(1, 240, 200, 200, 120)  # default fill = theme accent 1
  $cap7 = $s7.Shapes.AddTextbox(1, 60, 380, 840, 60)
  $cap7.TextFrame.TextRange.Text = $content.theme.caption
  Set-Notes $s7 $content.notes.'7'
  Add-PageTag $s7 7 8

  # --- slide 8: external hyperlink + externally linked picture
  $s8 = $pres.Slides.Add(8, 2)
  Set-Title $s8 $content.external.title
  $linkTb = $s8.Shapes.AddTextbox(1, 60, 160, 700, 40)
  $linkTb.TextFrame.TextRange.Text = $content.external.linkText
  $linkTb.TextFrame.TextRange.Font.Underline = -1
  $linkTb.TextFrame.TextRange.Font.Color.RGB = Rgb 5 99 193
  $linkTb.TextFrame.TextRange.ActionSettings.Item(1).Hyperlink.Address = $content.external.linkUrl
  $cap8 = $s8.Shapes.AddTextbox(1, 60, 420, 560, 40)
  $cap8.TextFrame.TextRange.Text = $content.external.caption
  $ext = $s8.Shapes.AddPicture((Join-Path $samplesDir 'assets\linked-pic.png'), -1, 0, 620, 300, 280, 180)
  $ext.Line.Weight = 1.5; $ext.Line.ForeColor.RGB = Rgb 60 60 60
  Set-Notes $s8 $content.notes.'8'
  Add-PageTag $s8 8 8

  $result.slideCount = $pres.Slides.Count
  $pptxPath = Join-Path $samplesDir 'office-deck.pptx'
  $pres.SaveAs($pptxPath, 24)  # ppSaveAsOpenXMLPresentation
  $result.saved = $pptxPath

  for ($i = 1; $i -le $pres.Slides.Count; $i++) {
    $png = Join-Path $refDir ('slide-{0:D2}.png' -f $i)
    $pres.Slides.Item($i).Export($png, 'PNG', 1280, 720)
  }
  $result.refsExported = $pres.Slides.Count
  $pres.Close()
} finally {
  $pp.Quit()
}

# --- reference exports for the two hand-made round-39 samples (best effort)
$pp2 = New-Object -ComObject PowerPoint.Application
$pp2.DisplayAlerts = 1
try {
  foreach ($pair in @(@('dense-deck.pptx', 'ref\dense'), @('rich-deck.pptx', 'ref\rich'))) {
    $name = $pair[0]; $dir = Join-Path $outRoot $pair[1]
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $key = 'refs_' + $name.Split('.')[0]
    try {
      $p = $pp2.Presentations.Open((Join-Path $samplesDir $name), -1, 0, 0)
      for ($i = 1; $i -le $p.Slides.Count; $i++) {
        $p.Slides.Item($i).Export((Join-Path $dir ('slide-{0:D2}.png' -f $i)), 'PNG', 1280, 720)
      }
      $result[$key] = ('ok slides=' + $p.Slides.Count)
      $p.Close()
    } catch { $result[$key] = ('failed: ' + $_.Exception.Message) }
  }
} finally { $pp2.Quit() }

$result | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $outRoot 'result-office-deck.json')
Write-Output ('[office-deck] ' + ($result | ConvertTo-Json -Compress))
