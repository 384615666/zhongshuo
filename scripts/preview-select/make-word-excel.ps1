# Preview selection eval: author REAL Word/Excel samples via Office 2007 COM (ASCII-only script).
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) 'dist\desktop\preview-select'
$samplesDir = Join-Path $outRoot 'samples'
$c = Get-Content -Raw -Encoding UTF8 (Join-Path $scriptDir 'word-excel-content.json') | ConvertFrom-Json

if (Get-Process WINWORD,EXCEL -ErrorAction SilentlyContinue) {
  # 只清理本脚本先前崩溃残留（首次运行前已确认无用户 Office 进程）
  Get-Process WINWORD,EXCEL -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}

# ---- Word docx (skip if already produced by an earlier run)
if (-not (Test-Path (Join-Path $samplesDir 'word-sample.docx'))) {
$word = New-Object -ComObject Word.Application
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Add()
  $doc.Content.Text = (@($c.docx.paras) -join "`r")
  $doc.Paragraphs.Item(1).Range.Font.Size = 16
  $doc.Paragraphs.Item(1).Range.Font.Bold = -1
  # reference PDF straight from Word (ground truth column)
  $doc.SaveAs((Join-Path $samplesDir 'word-sample.docx'), 12)       # wdFormatXMLDocument
  $doc.ExportAsFixedFormat((Join-Path $outRoot 'ref\word-sample.pdf'), 17)  # wdExportFormatPDF
  $doc.Close($false)
} finally { $word.Quit() }
}

# ---- Excel xlsx (2 sheets, header + rows incl a formula)
$xl = New-Object -ComObject Excel.Application
$xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Add()
  while ($wb.Worksheets.Count -gt 1) { $wb.Worksheets.Item($wb.Worksheets.Count).Delete() }
  $ws = $wb.Worksheets.Item(1)
  $ws.Name = $c.xlsx.sheet1
  $cols = @('A', 'B', 'C')
  for ($col = 1; $col -le 3; $col++) { $ws.Range(($cols[$col - 1] + '1')).Value2 = [string]$c.xlsx.header[$col - 1]; $ws.Range(($cols[$col - 1] + '1')).Font.Bold = $true }
  for ($r = 0; $r -lt $c.xlsx.rows.Count; $r++) {
    for ($col = 1; $col -le 3; $col++) {
      $v = $c.xlsx.rows[$r][$col - 1]
      if ($v -like '=*') { $ws.Range(($cols[$col - 1] + [string]($r + 2))).Formula = [string]$v }
      elseif ($v -match '^\d+$') { $ws.Range(($cols[$col - 1] + [string]($r + 2))).Value2 = [double]$v }
      else { $ws.Range(($cols[$col - 1] + [string]($r + 2))).Value2 = [string]$v }
    }
  }
  $ws.Columns.Item('A:C').AutoFit() | Out-Null
  $ws2 = $wb.Worksheets.Add()
  $ws2.Name = $c.xlsx.sheet2
  $ws2.Range('A1').Value2 = 'detail sheet - Chinese detail'
  $wb.SaveAs((Join-Path $samplesDir 'excel-sample.xlsx'), 51)       # xlOpenXMLWorkbook
  $wb.Close($false)
} finally { $xl.Quit() }
Write-Output '[word-excel] OK'
