# Word 实开验证（第三十一轮二；真 Word 变体）。
# 本机 Word.Application ProgID 被 WPS 兼容劫持（LocalServer32=wps.exe），WPS COM 在快速
# 开关循环下崩溃（RPC 死）。绕行：spawn 真 WINWORD.EXE /automation → ROT GetActiveObject
# 附身 → 校验 app.Path 为真 Office 目录（非 WPS）后再验：
# - 打开 export.docx ReadOnly（损坏/非法 XML → COM 错，repairError 如实记录）；
# - 统计：pages（wdStatisticPages=2）/words（0）；全文 Content.Text 暗号核对（乱码/截断
#   检出）+ 非法控制字符残留；Tables.Count 与总行数（长表格不丢行）；
# - SaveAs2 PDF（wdFormatPDF=17——页图证据；真 Word 原生支持）。
# 单行 JSON 输出。已有 WINWORD 在跑时拒绝（ROT 无法区分实例——不退出用户交互 Word）。
param(
  [Parameter(Mandatory = $true)][string]$ManifestPath
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$result = [ordered]@{ engine = $null; docx = $null; opened = $false; repairError = $null; pages = 0; words = 0; tables = 0; tableRows = 0; markers = @{}; controlCharsLeft = $false; textLength = 0; pdfExport = $false; pdfPath = $null }
function Emit {
  param($o)
  [Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 -InputObject $o))
}
$manifest = Get-Content -LiteralPath $ManifestPath -Encoding UTF8 | ConvertFrom-Json
$result.docx = $manifest.docx
$exe = $manifest.wordExe
if (-not (Test-Path -LiteralPath $exe)) { $result.repairError = "WINWORD not found: $exe"; Emit $result; exit 0 }
$existing = Get-Process -Name WINWORD -ErrorAction SilentlyContinue
if ($existing -and $existing.Count -gt 0) {
  # 上一轮自动化实例可能仍在退出窗口——有界等待退净（不杀不认识的进程）。
  $waited = 0
  while ($waited -lt 15) {
    Start-Sleep -Milliseconds 500
    $waited++
    $existing = Get-Process -Name WINWORD -ErrorAction SilentlyContinue
    if (-not $existing -or $existing.Count -eq 0) { break }
  }
  if ($existing -and $existing.Count -gt 0) { $result.repairError = 'WINWORD already running (ROT 实例无法区分——先关闭 Word)'; Emit $result; exit 0 }
}
$proc = Start-Process -FilePath $exe -ArgumentList '/automation' -PassThru
$app = $null
$doc = $null
try {
  $attached = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $app = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
      $attached = $true
      break
    } catch { }
  }
  if (-not $attached) { $result.repairError = 'GetActiveObject 超时（真 Word 未注册 ROT）'; Emit $result; exit 0 }
  $result.engine = $app.Path
  if ($app.Path -notlike '*Microsoft Office*') { $result.repairError = 'attached Word 非真 Office（ProgID 劫持?）path=' + $app.Path; Emit $result; exit 0 }
  $app.Visible = $false
  $app.DisplayAlerts = 0
  try {
    $doc = $app.Documents.Open($manifest.docx, $false, $true, $false)
    $result.opened = $true
  } catch {
    $result.repairError = $_.Exception.Message
  }
  if ($doc -ne $null) {
    $result.pages = $doc.ComputeStatistics(2)
    $result.words = $doc.ComputeStatistics(0)
    $text = $doc.Content.Text
    $result.textLength = $text.Length
    foreach ($m in $manifest.markers) { $result.markers[$m] = $text.Contains($m) }
    $result.controlCharsLeft = [regex]::IsMatch($text, '[\x00-\x08\x0B\x0C\x0E-\x1F]')
    $result.tables = $doc.Tables.Count
    if ($result.tables -gt 0) {
      $rows = 0
      for ($i = 1; $i -le $doc.Tables.Count; $i++) { $rows += $doc.Tables.Item($i).Rows.Count }
      $result.tableRows = $rows
    }
    if ($manifest.pdfPath) {
      try {
        $doc.SaveAs2([ref]$manifest.pdfPath, [ref]17)
        if (Test-Path -LiteralPath $manifest.pdfPath) { $result.pdfExport = $true; $result.pdfPath = $manifest.pdfPath }
      } catch { $result.pdfExport = $false }
    }
  }
} catch {
  $result.repairError = if ($result.repairError) { "$($result.repairError); $($_.Exception.Message)" } else { $_.Exception.Message }
} finally {
  if ($doc -ne $null) { try { $doc.Close($false) } catch { } }
  if ($app -ne $null) { try { $app.Quit() } catch { } }
  Start-Sleep -Milliseconds 800
  if ($proc -and -not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { } }
}
Emit $result
