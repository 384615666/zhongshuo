param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$TargetJson
)

$ErrorActionPreference = 'Stop'
$facts = [ordered]@{ ok = $false }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class R90NativeDrag {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  public const uint MOVE = 0x0001;
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint ABSOLUTE = 0x8000;
  public const uint VIRTUALDESK = 0x4000;
  public static void SendMouse(uint flags, int dx, int dy) {
    var inputs = new INPUT[1];
    inputs[0].type = 0;
    inputs[0].mi.dx = dx;
    inputs[0].mi.dy = dy;
    inputs[0].mi.dwFlags = flags;
    SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[void][R90NativeDrag]::SetProcessDpiAwarenessContext([IntPtr](-4))

function Get-TopWindow([IntPtr]$handle) {
  if (-not [R90NativeDrag]::IsWindowVisible($handle)) { return $null }
  $title = New-Object System.Text.StringBuilder 512
  [void][R90NativeDrag]::GetWindowText($handle, $title, $title.Capacity)
  $class = New-Object System.Text.StringBuilder 128
  [void][R90NativeDrag]::GetClassName($handle, $class, $class.Capacity)
  [uint32]$processId = 0
  [void][R90NativeDrag]::GetWindowThreadProcessId($handle, [ref]$processId)
  if ($processId -eq 0) { return $null }
  return [pscustomobject]@{ Handle = $handle; Pid = $processId; Title = $title.ToString(); Class = $class.ToString() }
}

function List-TopWindows {
  $items = New-Object System.Collections.Generic.List[object]
  $callback = [R90NativeDrag+EnumWindowsProc]{
    param($handle, $data)
    $fact = Get-TopWindow $handle
    if ($null -ne $fact) { $items.Add($fact) }
    return $true
  }
  [void][R90NativeDrag]::EnumWindows($callback, [IntPtr]::Zero)
  return $items
}

function Focus-Window([IntPtr]$handle) {
  [uint32]$targetPid = 0
  $targetThread = [R90NativeDrag]::GetWindowThreadProcessId($handle, [ref]$targetPid)
  $currentThread = [R90NativeDrag]::GetCurrentThreadId()
  [void][R90NativeDrag]::AttachThreadInput($currentThread, $targetThread, $true)
  [void][R90NativeDrag]::ShowWindow($handle, 9)
  [void][R90NativeDrag]::BringWindowToTop($handle)
  [void][R90NativeDrag]::SetForegroundWindow($handle)
  [void][R90NativeDrag]::AttachThreadInput($currentThread, $targetThread, $false)
}

function Move-Absolute([int]$x, [int]$y) {
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $nx = [int][math]::Round(($x - $screen.Left) * 65535 / ($screen.Width - 1))
  $ny = [int][math]::Round(($y - $screen.Top) * 65535 / ($screen.Height - 1))
  [R90NativeDrag]::SendMouse([R90NativeDrag]::MOVE -bor [R90NativeDrag]::ABSOLUTE -bor [R90NativeDrag]::VIRTUALDESK, $nx, $ny)
}

function Get-PointWindow([int]$x, [int]$y) {
  $point = New-Object R90NativeDrag+POINT
  $point.X = $x
  $point.Y = $y
  $handle = [R90NativeDrag]::WindowFromPoint($point)
  $fact = Get-TopWindow $handle
  if ($null -eq $fact) { return [pscustomobject]@{ Handle = $handle.ToInt64(); Pid = 0; Title = ''; Class = '' } }
  return [pscustomobject]@{ Handle = $handle.ToInt64(); Pid = $fact.Pid; Title = $fact.Title; Class = $fact.Class }
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  $target = Get-Content -LiteralPath $TargetJson -Raw | ConvertFrom-Json
  $filePath = [IO.Path]::GetFullPath([string]$target.filePath)
  $fileName = [IO.Path]::GetFileName($filePath)
  if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { throw "source file missing: $filePath" }
  $app = Get-Process -Id $AppPid -ErrorAction Stop
  $appHandle = [IntPtr]$app.MainWindowHandle
  if ($appHandle -eq [IntPtr]::Zero) { throw 'app window handle missing' }

  $before = @{}
  foreach ($window in List-TopWindows) { $before[[string]$window.Handle] = $true }
  Start-Process explorer.exe -ArgumentList ('/select,"' + $filePath + '"')

  $deadline = (Get-Date).AddSeconds(20)
  $explorer = $null
  while ((Get-Date) -lt $deadline -and $null -eq $explorer) {
    Start-Sleep -Milliseconds 250
    $explorer = List-TopWindows | Where-Object {
      $_.Class -eq 'CabinetWClass' -and -not $before.ContainsKey([string]$_.Handle) -and $_.Title.Length -gt 0
    } | Select-Object -First 1
  }
  if ($null -eq $explorer) { throw 'owned Explorer window not found' }

  [void][R90NativeDrag]::SetWindowPos($appHandle, [IntPtr](-1), 5600, -400, 1280, 1152, 0x0050)
  [void][R90NativeDrag]::SetWindowPos([IntPtr]$explorer.Handle, [IntPtr](-1), 4800, -400, 800, 1152, 0x0040)
  Focus-Window ([IntPtr]$explorer.Handle)
  Start-Sleep -Milliseconds 700

  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$explorer.Handle)
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $fileName)
  $item = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($null -eq $item) { throw "Explorer item not found: $fileName" }
  $item.SetFocus()
  Start-Sleep -Milliseconds 250
  $rect = $item.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) { throw 'Explorer item has no visible rectangle' }
  $sourceX = [int][math]::Round($rect.X + $rect.Width / 2)
  $sourceY = [int][math]::Round($rect.Y + $rect.Height / 2)
  $appRect = New-Object R90NativeDrag+RECT
  [void][R90NativeDrag]::GetWindowRect($appHandle, [ref]$appRect)
  $appWidth = $appRect.Right - $appRect.Left
  $appHeight = $appRect.Bottom - $appRect.Top
  $scaleX = $appWidth / [double]$target.outerWidth
  $scaleY = $appHeight / [double]$target.outerHeight
  $contentOffsetX = ([double]$target.outerWidth - [double]$target.innerWidth) / 2 * $scaleX
  $contentOffsetY = ([double]$target.outerHeight - [double]$target.innerHeight) / 2 * $scaleY
  $targetX = [int][math]::Round($appRect.Left + $contentOffsetX + [double]$target.cssX * $scaleX)
  $targetY = [int][math]::Round($appRect.Top + $contentOffsetY + [double]$target.cssY * $scaleY)
  $sourceWindow = Get-PointWindow $sourceX $sourceY
  $targetWindow = Get-PointWindow $targetX $targetY
  $foreground = Get-TopWindow ([R90NativeDrag]::GetForegroundWindow())

  Focus-Window ([IntPtr]$explorer.Handle)
  Start-Sleep -Milliseconds 450
  Move-Absolute $sourceX $sourceY
  Start-Sleep -Milliseconds 350
  [R90NativeDrag]::SendMouse([R90NativeDrag]::LEFTDOWN, 0, 0)
  [R90NativeDrag]::SendMouse([R90NativeDrag]::LEFTUP, 0, 0)
  Start-Sleep -Milliseconds 300
  [R90NativeDrag]::SendMouse([R90NativeDrag]::LEFTDOWN, 0, 0)
  Start-Sleep -Milliseconds 450
  for ($i = 1; $i -le 55; $i++) {
    Move-Absolute ([int]($sourceX + ($targetX - $sourceX) * $i / 55)) ([int]($sourceY + ($targetY - $sourceY) * $i / 55))
    Start-Sleep -Milliseconds 50
  }
  $holdMs = if ($env:ZS_R90_DRAG_HOLD_MS) { [int]$env:ZS_R90_DRAG_HOLD_MS } else { 450 }
  Start-Sleep -Milliseconds $holdMs
  [R90NativeDrag]::SendMouse([R90NativeDrag]::LEFTUP, 0, 0)
  Start-Sleep -Seconds 2

  $facts.ok = $true
  $facts.appPid = $AppPid
  $facts.appHandle = $appHandle.ToInt64()
  $facts.explorerPid = $explorer.Pid
  $facts.explorerHandle = ([IntPtr]$explorer.Handle).ToInt64()
  $facts.explorerTitle = $explorer.Title
  $facts.fileName = $fileName
  $facts.source = @{ x = $sourceX; y = $sourceY; left = $rect.X; top = $rect.Y; width = $rect.Width; height = $rect.Height }
  $facts.target = @{ x = $targetX; y = $targetY }
  $facts.sourceWindow = $sourceWindow
  $facts.targetWindow = $targetWindow
  $facts.foreground = $foreground
} catch {
  $facts.error = $_.Exception.Message
  throw
} finally {
  if ($null -ne $explorer) {
    [void][R90NativeDrag]::SendMessage([IntPtr]$explorer.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  }
  $facts | ConvertTo-Json -Depth 6 -Compress
}
