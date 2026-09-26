# 系统对话框探测/关闭（#32770 = Windows 公共对话框窗口类）。
#
# 为什么需要它：目录选择器是**操作系统级窗口**，渲染层与 CDP 都观测不到 ——
# 「点一下有没有真的弹出资源管理器」只能用操作系统层面的证据来判断。
# verify-desktop.ps1 是"只关不问"的一次性脚本，这里补一个可复用的探针：
#   -Mode find   只报告有没有（不关闭），退出码 0 = 找到、1 = 没找到
#   -Mode close  找到并关闭，退出码同上
# -Owner electron 只认 electron.exe 进程拥有的窗口（默认）；any = 任意进程（兜底，可能误伤别的应用）。
#
# 编码：本文件必须存为 **UTF-8 with BOM**。PowerShell 5.1 在没有 BOM 时按系统 ANSI（本机 GBK）
# 读脚本，中文注释会被解成乱码并把脚本读成语法错误（实测踩到：报"字符串缺少终止符"）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/dialog-probe.ps1 -Mode find -Owner electron -WaitSeconds 3
#   powershell -ExecutionPolicy Bypass -File scripts/dialog-probe.ps1 -Mode close -Owner electron -WaitSeconds 10

# 注意：参数名不要用 `$Action` —— 这是 PowerShell 的自动变量，绑定会被它顶掉，
# 表现是"传了 -Action find 却走了 close 分支"（实测踩到）。
param(
  [ValidateSet('find', 'close')][string]$Mode = 'find',
  [ValidateSet('electron', 'any')][string]$Owner = 'electron',
  [int]$WaitSeconds = 3
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ZsDlg {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] private static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);

  public static IntPtr Found = IntPtr.Zero;
  public static string Title = "";

  /** 找第一个可见的 #32770；pids 为空数组时不过滤进程归属 */
  public static void Scan(uint[] pids) {
    Found = IntPtr.Zero;
    Title = "";
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      if (Found != IntPtr.Zero) return true;
      if (!IsWindowVisible(h)) return true;
      var cn = new StringBuilder(64);
      GetClassName(h, cn, 64);
      if (cn.ToString() != "#32770") return true;
      if (pids.Length > 0) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (Array.IndexOf(pids, pid) < 0) return true;
      }
      Found = h;
      var t = new StringBuilder(256);
      GetWindowText(h, t, 256);
      Title = t.ToString();
      return true;
    }, IntPtr.Zero);
  }

  public static string Close(IntPtr h) {
    SetForegroundWindow(h);
    Thread.Sleep(250);
    if (GetForegroundWindow() == h) {
      keybd_event(0x1B, 0, 0, IntPtr.Zero);
      keybd_event(0x1B, 0, 2, IntPtr.Zero);
      if (WaitGone(h, 1500)) return "esc";
    }
    PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);  // WM_CLOSE（定向，不需要焦点）
    return WaitGone(h, 2000) ? "wm_close" : "failed";
  }

  private static bool WaitGone(IntPtr h, int ms) {
    for (int i = 0; i < ms / 100; i++) {
      Thread.Sleep(100);
      if (!IsWindow(h)) return true;
    }
    return !IsWindow(h);
  }
}
'@

if ($Owner -eq 'electron') {
  $pids = @(Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if ($pids.Count -eq 0) { Write-Output '未发现 electron.exe 进程 —— 请先运行 pnpm run desktop:debug'; exit 1 }
} else {
  $pids = @()
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  [ZsDlg]::Scan($pids)
  if ([ZsDlg]::Found -ne [IntPtr]::Zero) { $hwnd = [ZsDlg]::Found; break }
  Start-Sleep -Milliseconds 300
}

if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output "未发现系统对话框（#32770，owner=$Owner，等待 ${WaitSeconds}s）"
  exit 1
}

if ($Mode -eq 'find') {
  Write-Output ("发现系统对话框 h=$hwnd title='" + [ZsDlg]::Title + "'")
  exit 0
}

$title = [ZsDlg]::Title
$how = [string][ZsDlg]::Close($hwnd)

# 关掉之后**重新枚举**再确认一次：`IsWindow` 在某些对话框上会给出"已消失"的假结论
# （本机 Windows 11 + Electron 33 的目录选择器实测如此）—— 关闭结果必须靠重新扫描判定，
# 否则会打印"已关闭"而窗口还停在屏幕上。
Start-Sleep -Milliseconds 400
[ZsDlg]::Scan($pids)
if ([ZsDlg]::Found -ne [IntPtr]::Zero) {
  Write-Output ("对话框仍在屏幕上（h=" + [ZsDlg]::Found + " title='" + [ZsDlg]::Title + "'）：程序化关闭无效，请手动按 Esc 或重启桌面宿主")
  exit 1
}
Write-Output ("已关闭系统对话框 h=$hwnd title='" + $title + "' 方式=$how")
exit 0
