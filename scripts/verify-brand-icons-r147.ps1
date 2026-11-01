param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Icon, [Parameter(Mandatory=$true)][string]$Output, [int]$WindowProcessId=0)
$ErrorActionPreference = 'Stop'
$Executable=[System.IO.Path]::GetFullPath($Executable)
$Icon=[System.IO.Path]::GetFullPath($Icon)
$Output=[System.IO.Path]::GetFullPath($Output)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrandIconProbe {
    delegate bool WindowCallback(IntPtr window,IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr window,System.Text.StringBuilder text,int size);
    public static IntPtr WindowForProcess(int process) {
        IntPtr found=IntPtr.Zero;
        WindowCallback callback=delegate(IntPtr window,IntPtr parameter){uint pid;GetWindowThreadProcessId(window,out pid);if(pid==(uint)process){var name=new System.Text.StringBuilder(256);GetClassNameW(window,name,256);if(name.ToString()=="Chrome_WidgetWin_1"){found=window;return false;}}return true;};
        for(int i=0;i<40;i++){EnumWindows(callback,IntPtr.Zero);if(found!=IntPtr.Zero)return found;System.Threading.Thread.Sleep(50);}return found;
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Info {public IntPtr Icon;public int Index;public uint Attributes;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string DisplayName;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=80)]public string TypeName;}
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SHGetFileInfoW(string path,uint attrs,out Info info,uint size,uint flags);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(uint events,uint flags,string path,IntPtr reserved);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr SendMessageTimeoutW(IntPtr window,uint message,IntPtr wparam,IntPtr lparam,uint flags,uint timeout,out IntPtr result);
    [StructLayout(LayoutKind.Sequential)] struct Key {public Guid Format;public uint Id;}
    [StructLayout(LayoutKind.Explicit,Size=24)] struct Value {[FieldOffset(0)]public ushort Type;[FieldOffset(8)]public IntPtr Data;}
    [ComImport,Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Store {
        [PreserveSig]int GetCount(out uint count);[PreserveSig]int GetAt(uint index,out Key key);[PreserveSig]int GetValue(ref Key key,out Value value);[PreserveSig]int SetValue(ref Key key,ref Value value);[PreserveSig]int Commit();
    }
    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window,ref Guid iid,out Store store);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
    public static string WindowProperty(IntPtr window,uint id) {
        Guid iid=typeof(Store).GUID;Store store;Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window,ref iid,out store));
        try {var key=new Key {Format=new Guid("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3"),Id=id};Value value;Marshal.ThrowExceptionForHR(store.GetValue(ref key,out value));try {return value.Type==31?Marshal.PtrToStringUni(value.Data):value.Type==8?Marshal.PtrToStringBSTR(value.Data):null;}finally{PropVariantClear(ref value);}}finally{Marshal.ReleaseComObject(store);}
    }
}
'@
New-Item -ItemType Directory -Path $Output -Force | Out-Null
$checks = [System.Collections.Generic.List[object]]::new()
function Check([string]$name,[bool]$ok) { $checks.Add(@{name=$name;ok=$ok});if(-not $ok){throw $name} }
function Pixels($bitmap) {
    $bytes=[byte[]]::new($bitmap.Width*$bitmap.Height*4)
    for($y=0;$y -lt $bitmap.Height;$y++){for($x=0;$x -lt $bitmap.Width;$x++){$color=$bitmap.GetPixel($x,$y);$i=($y*$bitmap.Width+$x)*4;$bytes[$i]=$color.R;$bytes[$i+1]=$color.G;$bytes[$i+2]=$color.B;$bytes[$i+3]=$color.A}}
    return ,$bytes
}
function ShellBitmap([string]$path) {
    $info=[BrandIconProbe+Info]::new()
    $found=[BrandIconProbe]::SHGetFileInfoW($path,0,[ref]$info,[Runtime.InteropServices.Marshal]::SizeOf($info),0x100)
    if($found -eq [IntPtr]::Zero -or $info.Icon -eq [IntPtr]::Zero){throw "Shell icon missing: $path"}
    try { return [System.Drawing.Icon]::FromHandle($info.Icon).ToBitmap() } finally { [BrandIconProbe]::DestroyIcon($info.Icon) | Out-Null }
}
$reference=ShellBitmap $Icon
$application=ShellBitmap $Executable
try {
    $application.Save((Join-Path $Output 'exe.png'),[System.Drawing.Imaging.ImageFormat]::Png)
    $reference.Save((Join-Path $Output 'ico.png'),[System.Drawing.Imaging.ImageFormat]::Png)
    Check 'EXE native icon uses the source logo' ([Convert]::ToBase64String((Pixels $application)) -eq [Convert]::ToBase64String((Pixels $reference)))
    $link=Join-Path $Output 'Zhongshuo-icon-check.lnk'
    $shell=New-Object -ComObject WScript.Shell
    $shortcut=$shell.CreateShortcut($link);$shortcut.TargetPath=$Executable;$shortcut.IconLocation="$Icon,0";$shortcut.Save()
    [BrandIconProbe]::SHChangeNotify(0x2000,0x1005,$link,[IntPtr]::Zero)
    $shortcutIcon=ShellBitmap $link
    try {
        $shortcutIcon.Save((Join-Path $Output 'shortcut.png'),[System.Drawing.Imaging.ImageFormat]::Png)
        $same=$shortcutIcon.Width -eq $reference.Width -and $shortcutIcon.Height -eq $reference.Height
        for($y=0;$y -lt $reference.Height;$y++){for($x=0;$x -lt $reference.Width;$x++){
            # The Shell adds its own shortcut arrow in the lower-left corner.
            if($x -lt 16 -and $y -ge 16){continue}
            if($shortcutIcon.GetPixel($x,$y).ToArgb() -ne $reference.GetPixel($x,$y).ToArgb()){$same=$false}
        }}
        Check 'Windows Shell shortcut displays the new logo' $same
    } finally {$shortcutIcon.Dispose()}
    if($WindowProcessId -gt 0){
        $window=[BrandIconProbe]::WindowForProcess($WindowProcessId)
        Check 'native window is present' ($window -ne [IntPtr]::Zero)
        Check ('taskbar has the application identity: '+[BrandIconProbe]::WindowProperty($window,5)) (-not [String]::IsNullOrWhiteSpace([BrandIconProbe]::WindowProperty($window,5)))
        $taskbarIconResource=[BrandIconProbe]::WindowProperty($window,3)
        $taskbarIconPath=if($taskbarIconResource){($taskbarIconResource -replace ',0$','').Trim('"')}else{''}
        Check ('taskbar relaunch icon points to the hashed logo resource: '+$taskbarIconResource) ($taskbarIconPath -eq $Icon)
        $native=[IntPtr]::Zero
        [BrandIconProbe]::SendMessageTimeoutW($window,0x7f,[IntPtr]1,[IntPtr]::Zero,2,2000,[ref]$native) | Out-Null
        Check 'native window has its own icon' ($native -ne [IntPtr]::Zero)
        $windowBitmap=[System.Drawing.Icon]::FromHandle($native).ToBitmap()
        $scaled=[System.Drawing.Bitmap]::new($windowBitmap,32,32)
        try {
            $expected=[System.Drawing.Bitmap]::new($reference,32,32)
            try {$a=Pixels $scaled;$b=Pixels $expected;$difference=0.0;for($i=0;$i -lt $a.Length;$i+=4){for($c=0;$c -lt 3;$c++){$difference += [Math]::Abs([int]$a[$i+$c]-[int]$b[$i+$c])}};$imageError=$difference/(32*32*3*255);Check 'native window icon matches the logo' ($imageError -lt 0.06)} finally {$expected.Dispose()}
            $windowBitmap.Save((Join-Path $Output 'window.png'),[System.Drawing.Imaging.ImageFormat]::Png)
        } finally {$scaled.Dispose();$windowBitmap.Dispose()}
    }
    $report=@{ok=$true;checks=$checks;executable=$Executable;icon=$Icon;windowProcessId=$WindowProcessId;taskbarIconResource=$taskbarIconResource}
} catch {$report=@{ok=$false;checks=$checks;error=$_.Exception.Message}}
finally {$application.Dispose();$reference.Dispose()}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Output 'report.json') -Encoding UTF8
$report | ConvertTo-Json -Depth 6
if(-not $report.ok){exit 1}
