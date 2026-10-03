# Excel reference PDF export (ground truth for the Word/Excel smoke composite)
$ErrorActionPreference = 'Stop'
$root = 'D:\zhongshuo\dist\desktop\preview-select'
if (Get-Process EXCEL -ErrorAction SilentlyContinue) { Get-Process EXCEL | Stop-Process -Force; Start-Sleep -Seconds 2 }
$xl = New-Object -ComObject Excel.Application
$xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Open((Join-Path $root 'samples\excel-sample.xlsx'), 0, $true)
  $wb.ExportAsFixedFormat(0, (Join-Path $root 'ref\excel-sample.pdf'))  # xlTypePDF
  $wb.Close($false)
  Write-Output '[excel-ref] OK'
} finally { $xl.Quit() }
