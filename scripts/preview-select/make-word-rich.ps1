# Round 40 Block D2: rich Word sample via Word 2007 COM + reference PDF (ASCII-only; Chinese from JSON)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) 'dist\desktop\preview-select'
$samplesDir = Join-Path $outRoot 'samples'
$c = Get-Content -Raw -Encoding UTF8 (Join-Path $scriptDir 'word-rich-content.json') | ConvertFrom-Json
if (Get-Process WINWORD -ErrorAction SilentlyContinue) { Get-Process WINWORD | Stop-Process -Force; Start-Sleep -Seconds 2 }
$word = New-Object -ComObject Word.Application
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Add()
  $doc.PageSetup.PageWidth = $word.CentimetersToPoints(21.0)
  $doc.PageSetup.PageHeight = $word.CentimetersToPoints(29.7)
  $header = $doc.Sections.Item(1).Headers.Item(1)
  $header.Range.Text = [string]$c.header
  $header.Range.Font.Size = 9
  $footer = $doc.Sections.Item(1).Footers.Item(1)
  $footer.Range.Text = 'page '
  $footer.Range.Fields.Add($footer.Range, 33) | Out-Null   # wdFieldPage
  $footer.Range.Font.Size = 9

  $sel = $word.Selection
  $sel.Font.Size = 16; $sel.Font.Bold = -1
  $sel.TypeText([string]$c.title)
  $sel.TypeParagraph()
  $sel.Font.Size = 11; $sel.Font.Bold = 0
  $sel.TypeText([string]$c.p1)
  $sel.TypeParagraph()
  $sel.TypeText([string]$c.p2)
  $sel.TypeParagraph()
  $tblRng = $doc.Content
  $tblRng.Collapse(0)
  $table = $doc.Tables.Add($tblRng, 3, 4)
  for ($col = 1; $col -le 4; $col++) {
    $cell = $table.Cell(1, $col)
    $cell.Range.Text = [string]$c.tableHeader[$col - 1]
    $cell.Range.Font.Bold = -1
  }
  for ($r = 2; $r -le 3; $r++) {
    for ($col = 1; $col -le 4; $col++) { $table.Cell($r, $col).Range.Text = [string]$c.tableRows[$r - 2][$col - 1] }
  }
  $table.Borders.Enable = $true
  $sel2 = $word.Selection
  $sel2.EndKey(6) | Out-Null    # wdStory
  $sel2.TypeParagraph()
  $sel2.TypeText([string]$c.p3)
  $sel2.TypeParagraph()
  $sel2.InlineShapes.AddPicture((Join-Path $samplesDir 'assets\embed-pic.png')) | Out-Null
  $sel2.InsertBreak(7)          # wdPageBreak
  $sel2.Font.Size = 14; $sel2.Font.Bold = -1
  $sel2.TypeText([string]$c.page2Title)
  $sel2.Font.Size = 11; $sel2.Font.Bold = 0
  foreach ($p in @($c.page2Paras)) {
    $sel2.TypeParagraph()
    $sel2.TypeText([string]$p)
  }
  $sel2.InsertBreak(7)
  $sel2.Font.Size = 14; $sel2.Font.Bold = -1
  $sel2.TypeText([string]$c.page3Title)
  $sel2.Font.Size = 11; $sel2.Font.Bold = 0
  $sel2.TypeParagraph()
  $sel2.TypeText([string]$c.page3Para)

  $doc.SaveAs((Join-Path $samplesDir 'word-rich.docx'), 12)
  $doc.ExportAsFixedFormat((Join-Path $outRoot 'ref\word-rich.pdf'), 17)
  $doc.Close($false)
  Write-Output '[word-rich] OK'
} finally { $word.Quit() }
