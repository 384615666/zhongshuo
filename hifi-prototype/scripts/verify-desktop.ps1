# 关闭 verify-desktop.mjs 最后一步调起的**系统模态目录对话框**。
#
# 背景：CDP 的按键事件只能到渲染进程，到不了系统对话框；verify-desktop.mjs
# 因此把"原生目录选择器"放在最后一项，只证明"对话框确实被调起"（调用 1.8s 未返回），
# 随后由本脚本从操作系统层面发送 ESC 关闭，避免用例挂死、窗口被模态框卡住。
#
# 用法（两个终端）：
#   1) node scripts/verify-desktop.mjs        # 它会停在最后一项，对话框保持打开
#   2) powershell -ExecutionPolicy Bypass -File scripts/verify-desktop.ps1
#
# 说明：本脚本会先等对话框出现（默认最多 30s），再把它置前并发送 ESC；
# 若对话框不响应 ESC，退回发送 WM_CLOSE（对目录选择器等价于"取消"）。
# 只操作 electron.exe 进程拥有的 #32770 窗口，不动其它应用。

param([int]$WaitSeconds = 30)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ZsDialogEsc {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] private static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

  public static IntPtr Find(uint[] pids, bool requireOwner) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(64);
      GetClassName(h, sb, sb.Capacity);
      if (sb.ToString() != "#32770") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      bool owned = false;
      foreach (uint p in pids) if (p == pid) { owned = true; break; }
      if (requireOwner && !owned) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static string Close(IntPtr h) {
    SetForegroundWindow(h);
    Thread.Sleep(250);
    // 只在对话框确实处于前台时才发全局按键，避免 ESC 落到别的应用窗口
    if (GetForegroundWindow() == h) {
      keybd_event(0x1B, 0, 0, IntPtr.Zero);   // ESC down
      keybd_event(0x1B, 0, 2, IntPtr.Zero);   // ESC up
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

$pids = @(Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
if ($pids.Count -eq 0) { Write-Output '未发现 electron.exe 进程 —— 请先运行 pnpm run desktop:debug'; exit 1 }

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $hwnd -eq [IntPtr]::Zero) {
  $hwnd = [ZsDialogEsc]::Find($pids, $true)
  if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 300 }
}
if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [ZsDialogEsc]::Find($pids, $false) }  # 兜底：任意 #32770
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "等待 ${WaitSeconds}s 未发现系统目录对话框（#32770）"; exit 1 }

$how = [ZsDialogEsc]::Close($hwnd)
if ($how -eq 'failed') { Write-Output "对话框仍未关闭：$hwnd（请手动按 ESC）"; exit 1 }
Write-Output "已关闭系统目录对话框（$how）：$hwnd"; exit 0
