# Installer-only process ownership and shutdown helper. Never touches app data.
# Exit 0 = clear, 10 = verified processes remain, 20 = cannot safely verify/stop.
param(
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][ValidateSet('Probe','Graceful','Force')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$TicketFile,
  [ValidateRange(1,30)][int]$TimeoutSeconds = 20,
  [switch]$Consent
)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'Force' -and -not $Consent) { Write-Output 'Explicit force consent is required'; exit 20 }
function Assert-InstalledIdentity([string]$Root) {
  $appExe = Join-Path $Root 'Zhongshuo.exe'
  $nodeExe = Join-Path $Root 'resources/app/daemon/node/node.exe'
  if (-not ((Test-Path -LiteralPath $appExe) -or (Test-Path -LiteralPath $nodeExe))) { return }
  $metadata = Get-Content -LiteralPath (Join-Path $Root 'resources/app/installed-desktop.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $brand = [string][char]0x4f17 + [string][char]0x8bf4
  if ($metadata.appId -ne 'com.zhongshuo.desktop' -or $metadata.productName -ne $brand -or $metadata.executable -ne 'Zhongshuo.exe') { throw 'Installed product identity could not be verified' }
  if (Test-Path -LiteralPath $appExe) {
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($appExe)
    if ($version.ProductName -ne $brand -or $version.OriginalFilename -ne 'Zhongshuo.exe') { throw 'Installed executable identity could not be verified' }
  }
}
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace ZhongshuoInstaller {
  public class Identity {
    public int Pid; public string Start; public string Image; public string Sid;
    public int RootPid; public int Depth; public int ParentPid; public string ParentStart;
  }
  public class Result {
    public int Code; public string Message; public Identity[] Processes; public Identity[] Approved;
    public int GracefulMessagesSent; public int ForcedCount;
  }
  public static class Processes {
    [StructLayout(LayoutKind.Sequential)] struct FT { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct PE {
      public uint Size, Usage, Pid; public IntPtr Heap; public uint Module, Threads, Parent;
      public int Priority; public uint Flags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
    }
    [StructLayout(LayoutKind.Sequential)] struct Unique { public int Pid; public FT Start; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct RMInfo {
      public Unique Process;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string Name;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string Service;
      public uint Type, Status, Session;
      [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref PE entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref PE entry);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out FT creation, out FT exit, out FT kernel, out FT user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint size, uint flags);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, uint flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint fileCount, string[] files, uint processCount, Unique[] processes, uint serviceCount, string[] services);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In,Out] RMInfo[] info, out uint reasons);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
    delegate bool WindowVisitor(IntPtr window,IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor,IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendMessageTimeoutW(IntPtr window,uint message,IntPtr wParam,IntPtr lParam,uint flags,uint timeout,out IntPtr result);

    static string CurrentSid { get { return WindowsIdentity.GetCurrent().User.Value; } }
    static string Stamp(FT value) { return (((ulong)value.High << 32) | value.Low).ToString(); }
    static FT FileTime(string value) { ulong n=ulong.Parse(value); return new FT { Low=(uint)n, High=(uint)(n>>32) }; }
    static bool Equal(string a,string b) { return String.Equals(a,b,StringComparison.OrdinalIgnoreCase); }
    static string Key(Identity value) { return value.Pid+":"+value.Start; }
    public static string Canonical(string path) {
      IntPtr h=CreateFileW(Path.GetFullPath(path),0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
      if(h==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot resolve install path");
      try {
        var text=new StringBuilder(32768); uint size=GetFinalPathNameByHandleW(h,text,(uint)text.Capacity,0);
        if(size==0||size>=text.Capacity)throw new Win32Exception(Marshal.GetLastWin32Error());
        string final=text.ToString();
        if(final.StartsWith(@"\\?\UNC\"))return @"\\"+final.Substring(8);
        return final.StartsWith(@"\\?\")?final.Substring(4):final;
      } finally { CloseHandle(h); }
    }
    class Held : IDisposable {
      public Identity Id; public IntPtr Handle;
      public bool Exited { get { return WaitForSingleObject(Handle,0)==0; } }
      public void Dispose() { if(Handle!=IntPtr.Zero){CloseHandle(Handle);Handle=IntPtr.Zero;} }
    }
    class Scope : IDisposable {
      public Dictionary<int,Held> Held = new Dictionary<int,Held>();
      public Identity[] Ids { get { return Held.Values.Select(p=>p.Id).ToArray(); } }
      public void Dispose() { foreach(var p in Held.Values)p.Dispose(); }
    }
    static Identity ReadIdentity(IntPtr handle,int pid) {
      FT start,exit,kernel,user;
      if(!GetProcessTimes(handle,out start,out exit,out kernel,out user))throw new Win32Exception(Marshal.GetLastWin32Error());
      var image=new StringBuilder(32768);int size=image.Capacity;
      if(!QueryFullProcessImageNameW(handle,0,image,ref size))throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr token;
      if(!OpenProcessToken(handle,8,out token))throw new Win32Exception(Marshal.GetLastWin32Error());
      string sid;
      try { using(var identity=new WindowsIdentity(token))sid=identity.User.Value; } finally { CloseHandle(token); }
      return new Identity { Pid=pid,Start=Stamp(start),Image=Canonical(image.ToString()),Sid=sid };
    }
    static Held Open(int pid,bool force) {
      IntPtr h=OpenProcess(0x00101000u|(force?1u:0u),false,pid);
      if(h==IntPtr.Zero) {
        int error=Marshal.GetLastWin32Error();if(error==87)return null;
        throw new Win32Exception(error,"Cannot verify process "+pid);
      }
      try {
        if(WaitForSingleObject(h,0)==0){CloseHandle(h);return null;}
        return new Held { Handle=h,Id=ReadIdentity(h,pid) };
      } catch { CloseHandle(h);throw; }
    }
    static List<PE> Snapshot() {
      IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
      if(snapshot==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        var result=new List<PE>();var entry=new PE { Size=(uint)Marshal.SizeOf(typeof(PE)) };
        if(!Process32FirstW(snapshot,ref entry))throw new Win32Exception(Marshal.GetLastWin32Error());
        do { result.Add(entry);entry.Size=(uint)Marshal.SizeOf(typeof(PE)); } while(Process32NextW(snapshot,ref entry));
        if(Marshal.GetLastWin32Error()!=18)throw new Win32Exception(Marshal.GetLastWin32Error());
        return result;
      } finally {CloseHandle(snapshot);}
    }
    static RMInfo[] ResourceUsers(string[] files) {
      if(files.Length==0)return new RMInfo[0];
      uint session;int status=RmStartSession(out session,0,new StringBuilder(33));
      if(status!=0)throw new Win32Exception(status,"Restart Manager probe failed");
      try {
        status=RmRegisterResources(session,(uint)files.Length,files,0,null,0,null);
        if(status!=0)throw new Win32Exception(status);
        for(int retry=0;retry<5;retry++) {
          uint needed,count=0,reasons;status=RmGetList(session,out needed,ref count,null,out reasons);
          if(status==0&&needed==0)return new RMInfo[0];
          if(status!=234)throw new Win32Exception(status);
          count=needed;var items=new RMInfo[count];status=RmGetList(session,out needed,ref count,items,out reasons);
          if(status==0)return items.Take((int)count).ToArray();
          if(status!=234)throw new Win32Exception(status);
        }
        throw new IOException("Restart Manager process list changed repeatedly");
      } finally {RmEndSession(session);}
    }
    static Scope Acquire(string root,Identity[] approved,bool force) {
      var scope=new Scope();var snapshots=Snapshot();
      var paths=new []{Path.Combine(root,"Zhongshuo.exe"),Path.Combine(root,@"resources\app\daemon\node\node.exe")};
      var existing=paths.Where(File.Exists).Select(Canonical).ToArray();
      var previous=approved==null?null:new HashSet<string>(approved.Select(Key));
      try {
        // The confirmation ticket retains a full verified lineage, even when a
        // parent exits gracefully before its runtime child. Reject broken chains.
        if(approved!=null)foreach(var expected in approved) {
          if(expected.Sid!=CurrentSid)throw new IOException("Ticket user does not match");
          if(expected.Depth==0) {
            if(expected.RootPid!=expected.Pid||!existing.Any(p=>Equal(p,expected.Image)))throw new IOException("Ticket root does not belong to this installation");
          } else {
            var parent=approved.FirstOrDefault(p=>p.Pid==expected.ParentPid&&p.Start==expected.ParentStart);
            if(parent==null||parent.Depth+1!=expected.Depth||parent.RootPid!=expected.RootPid)throw new IOException("Ticket descendant lineage is not verified");
          }
        }
        foreach(var entry in snapshots.Where(p=>Equal(p.Name,"Zhongshuo.exe")||Equal(p.Name,"node.exe"))) {
          Held process;
          try { process=Open((int)entry.Pid,force); } catch(Win32Exception) { continue; }
          if(process==null)continue;
          if(!existing.Any(p=>Equal(p,process.Id.Image))){process.Dispose();continue;}
          if(process.Id.Sid!=CurrentSid){process.Dispose();throw new IOException("Target process belongs to another user");}
          if(previous!=null&&!previous.Contains(Key(process.Id))){process.Dispose();throw new IOException("A new target instance appeared after confirmation");}
          process.Id.RootPid=process.Id.Pid;scope.Held.Add(process.Id.Pid,process);
        }
        // Retain verified descendants across graceful exit of their parent.
        if(approved!=null)foreach(var expected in approved) {
          if(scope.Held.ContainsKey(expected.Pid))continue;
          var process=Open(expected.Pid,force);if(process==null)continue;
          if(process.Id.Start!=expected.Start){process.Dispose();continue;}
          if(!Equal(process.Id.Image,expected.Image)||process.Id.Sid!=CurrentSid||process.Id.Sid!=expected.Sid){process.Dispose();throw new IOException("Process identity changed");}
          process.Id.RootPid=expected.RootPid;process.Id.Depth=expected.Depth;process.Id.ParentPid=expected.ParentPid;process.Id.ParentStart=expected.ParentStart;scope.Held.Add(expected.Pid,process);
        }
        bool added;
        do {
          added=false;
          foreach(var entry in snapshots) {
            Held parent;if(scope.Held.ContainsKey((int)entry.Pid)||!scope.Held.TryGetValue((int)entry.Parent,out parent))continue;
            var child=Open((int)entry.Pid,force);if(child==null)continue;
            if(ulong.Parse(child.Id.Start)<ulong.Parse(parent.Id.Start)){child.Dispose();throw new IOException("Parent PID was reused");}
            if(child.Id.Sid!=CurrentSid){child.Dispose();throw new IOException("Cannot verify descendant user");}
            child.Id.RootPid=parent.Id.RootPid;child.Id.Depth=parent.Id.Depth+1;child.Id.ParentPid=parent.Id.Pid;child.Id.ParentStart=parent.Id.Start;scope.Held.Add(child.Id.Pid,child);added=true;
          }
        }while(added);
        if(scope.Held.ContainsKey(Process.GetCurrentProcess().Id))throw new IOException("Installer is inside the target process tree");
        foreach(var user in ResourceUsers(existing)) {
          Held known;
          if(!scope.Held.TryGetValue(user.Process.Pid,out known)) {
            // RM can briefly retain an exited PID with a zero start timestamp.
            // Ignore it only after the OS independently confirms it is gone.
            using(var current=Open(user.Process.Pid,false)) {if(current==null)continue;}
            throw new IOException("A target file is held by an unverified live process: pid="+user.Process.Pid);
          }
          if(known.Exited)continue;
          if(Stamp(user.Process.Start)=="0"&&WaitForSingleObject(known.Handle,100)==0)continue;
          if(known.Id.Start!=Stamp(user.Process.Start))
            throw new IOException("A target file is held by an unverified process: pid="+user.Process.Pid+", start="+Stamp(user.Process.Start));
        }
        return scope;
      }catch{scope.Dispose();throw;}
    }
    static int Graceful(Scope scope,int timeoutMs) {
      int sent=0;var watch=Stopwatch.StartNew();Exception failure=null;
      // RmShutdown can end noninteractive processes even with zero flags.
      // Only request the app's existing query-session-end shutdown event here;
      // no WM_CLOSE (tray hide), WM_ENDSESSION, console signal or termination.
      EnumWindows((window,parameter)=>{
        if(watch.ElapsedMilliseconds>=timeoutMs)return false;
        uint pid;GetWindowThreadProcessId(window,out pid);
        Held process;if(!scope.Held.TryGetValue((int)pid,out process)||process.Exited)return true;
        try {
          var fresh=ReadIdentity(process.Handle,(int)pid);
          if(Key(fresh)!=Key(process.Id)||fresh.Sid!=CurrentSid||!Equal(fresh.Image,process.Id.Image))throw new IOException("Window owner changed");
        }catch(Exception error){failure=error;return false;}
        uint confirmed;GetWindowThreadProcessId(window,out confirmed);if(confirmed!=pid)return true;
        IntPtr reply;
        // WM_QUERYENDSESSION / ENDSESSION_CLOSEAPP, SMTO_BLOCK|ABORTIFHUNG.
        if(SendMessageTimeoutW(window,0x11,IntPtr.Zero,new IntPtr(1),3,(uint)Math.Min(500,timeoutMs-watch.ElapsedMilliseconds),out reply)!=IntPtr.Zero)sent++;
        return true;
      },IntPtr.Zero);
      if(failure!=null)throw failure;
      return sent;
    }
    public static Result Run(string root,string mode,Identity[] approved,int seconds) {
      var result=new Result();var watch=Stopwatch.StartNew();Identity[] tracked;
      using(var scope=Acquire(root,approved,mode=="Force")) {
        tracked=scope.Ids;
        if(approved!=null)tracked=approved.Concat(tracked).GroupBy(Key).Select(group=>group.Last()).ToArray();
        result.Approved=tracked;
        if(mode=="Graceful")result.GracefulMessagesSent=Graceful(scope,seconds*1000);
        if(mode=="Force") {
          // All identities/handles are verified before the first termination.
          foreach(var process in scope.Held.Values.OrderByDescending(p=>p.Id.Depth)) {
            if(process.Exited)continue;
            var fresh=ReadIdentity(process.Handle,process.Id.Pid);
            if(Key(fresh)!=Key(process.Id)||!Equal(fresh.Image,process.Id.Image)||fresh.Sid!=CurrentSid)throw new IOException("Identity no longer matches retained handle");
            if(!TerminateProcess(process.Handle,3)&&!process.Exited)throw new Win32Exception(Marshal.GetLastWin32Error(),"Target process could not be stopped");
            result.ForcedCount++;
          }
        }
      }
      do {
        using(var remaining=Acquire(root,mode=="Probe"?null:tracked,false)) {
          result.Processes=remaining.Ids;result.Code=result.Processes.Length==0?0:10;
        }
        if(mode=="Probe"||result.Code==0)break;
        Thread.Sleep(100);
      }while(watch.ElapsedMilliseconds<seconds*1000);
      result.Message=result.Code==0?"Target installation is clear":"Verified target processes are still running";
      return result;
    }
  }
}
'@
  $root = [IO.Path]::GetFullPath($InstallDir)
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    if ($Mode -ne 'Probe') { throw 'Installation directory disappeared' }
    @{ Code=0; Message='No existing installation'; Processes=@() } | ConvertTo-Json | Set-Content -LiteralPath $TicketFile -Encoding UTF8
    exit 0
  }
  $root = [ZhongshuoInstaller.Processes]::Canonical($root)
  if ($Mode -ne 'Probe') { Assert-InstalledIdentity $root }
  $approved = $null
  if ($Mode -ne 'Probe') {
    $ticket = Get-Content -LiteralPath $TicketFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($ticket.InstallDir -ne $root -or $ticket.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $ticket.SchemaVersion -ne 1) { throw 'Ownership ticket does not match the installation/user' }
    $approved = @($ticket.Approved | ForEach-Object {
      $identity = New-Object ZhongshuoInstaller.Identity
      $identity.Pid=[int]$_.Pid; $identity.Start=[string]$_.Start; $identity.Image=[string]$_.Image
      $identity.Sid=[string]$_.Sid; $identity.RootPid=[int]$_.RootPid; $identity.Depth=[int]$_.Depth
      $identity.ParentPid=[int]$_.ParentPid; $identity.ParentStart=[string]$_.ParentStart
      $identity
    })
  }
  $result = [ZhongshuoInstaller.Processes]::Run($root,$Mode,$approved,$TimeoutSeconds)
  # A non-running damaged installation can be repaired. Identity is mandatory
  # before offering/performing any operation against a running process.
  if ($Mode -eq 'Probe' -and $result.Processes.Length -gt 0) { Assert-InstalledIdentity $root }
  $record = @{ SchemaVersion=1; InstallDir=$root; Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Mode=$Mode; Code=$result.Code; Message=$result.Message; Processes=@($result.Processes); Approved=@($result.Approved); ForcedCount=$result.ForcedCount; GracefulMessagesSent=$result.GracefulMessagesSent; At=[DateTime]::UtcNow.ToString('o') }
  $record | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $TicketFile -Encoding UTF8
  Write-Output $result.Message
  exit $result.Code
} catch {
  Write-Output ('Installer process verification refused: ' + $_.Exception.Message)
  exit 20
}
