param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Executable)
[pscustomobject]@{
  productName = $info.ProductName
  fileDescription = $info.FileDescription
  fileVersion = $info.FileVersion
  productVersion = $info.ProductVersion
  originalFilename = $info.OriginalFilename
  companyName = $info.CompanyName
} | ConvertTo-Json -Compress
