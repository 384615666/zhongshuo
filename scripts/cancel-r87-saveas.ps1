param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedExe
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class R87SaveDialogNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@

$expected = [IO.Path]::GetFullPath($ExpectedExe).TrimEnd([char]92)
$found = New-Object System.Collections.Generic.List[object]
$callback = [R87SaveDialogNative+EnumWindowsProc]{
  param($handle, $unused)
  if (-not [R87SaveDialogNative]::IsWindowVisible($handle)) { return $true }
  $title = New-Object System.Text.StringBuilder 256
  [void][R87SaveDialogNative]::GetWindowText($handle, $title, $title.Capacity)
  if ($title.ToString() -ne '另存为') { return $true }
  if ([R87SaveDialogNative]::GetWindow($handle, 4) -eq [IntPtr]::Zero) { return $true }
  $processId = [uint32]0
  [void][R87SaveDialogNative]::GetWindowThreadProcessId($handle, [ref]$processId)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath)) { return $true }
  if ([IO.Path]::GetFullPath($process.ExecutablePath).TrimEnd([char]92) -ine $expected) { return $true }
  $found.Add([pscustomobject]@{ Handle = $handle; ProcessId = $processId })
  return $true
}
[void][R87SaveDialogNative]::EnumWindows($callback, [IntPtr]::Zero)

if ($found.Count -ne 1) {
  [pscustomobject]@{ cancelled = $false; found = $found.Count } | ConvertTo-Json -Compress
  exit 1
}

$target = $found[0]
[void][R87SaveDialogNative]::SendMessage($target.Handle, 0x0111, [IntPtr]2, [IntPtr]::Zero)
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
  if (-not [R87SaveDialogNative]::IsWindowVisible($target.Handle)) {
    [pscustomobject]@{ cancelled = $true; processId = $target.ProcessId } | ConvertTo-Json -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 100
}

[pscustomobject]@{ cancelled = $false; found = 1; closed = $false } | ConvertTo-Json -Compress
exit 1
