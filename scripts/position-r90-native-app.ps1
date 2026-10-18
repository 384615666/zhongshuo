param([Parameter(Mandatory = $true)][int]$AppPid)

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class R90PositionApp {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
[void][R90PositionApp]::SetProcessDpiAwarenessContext([IntPtr](-4))
$app = Get-Process -Id $AppPid -ErrorAction Stop
$handle = [IntPtr]$app.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'app window handle missing' }
[void][R90PositionApp]::ShowWindow($handle, 9)
[void][R90PositionApp]::SetWindowPos($handle, [IntPtr](-1), 5600, -400, 1280, 1152, 0x0040)
Start-Sleep -Milliseconds 500
[pscustomobject]@{ ok = $true; pid = $AppPid; handle = $handle.ToInt64(); x = 5600; y = -400; width = 1280; height = 1152 } | ConvertTo-Json -Compress
