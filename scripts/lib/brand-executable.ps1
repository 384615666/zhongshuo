param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Icon,
  [string]$Version,
  [string]$NumericVersion,
  [string]$ProductName = '众说',
  [string]$FileDescription = '众说',
  [string]$Company = '众说开源项目',
  [string]$Copyright = 'Copyright (C) 2026 众说开源项目',
  [string]$InternalName = 'Zhongshuo',
  [string]$OriginalFilename = 'Zhongshuo.exe',
  [string]$Comments = '本地多 Agent 协同工作台'
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class ZhongshuoNativeIcon {
    delegate bool Names(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
    delegate bool Languages(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool EnumResourceNamesW(IntPtr module, IntPtr type, Names callback, IntPtr parameter);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool EnumResourceLanguagesW(IntPtr module, IntPtr type, IntPtr name, Languages callback, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResourceW(string file, bool deleteExisting);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResourceW(IntPtr update, bool discard);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr FindResourceExW(IntPtr module, IntPtr type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr resource);
    class Group { public int Id; public string Name; public ushort Language; }
    class Frame { public byte Width, Height, Colors; public ushort Planes, Bits; public byte[] Data; }
    public class Result { public int Groups; public int Frames; public int Languages; public bool Verified; }
    static void Require(bool ok, string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static IntPtr GroupName(Group group) { return group.Name == null ? new IntPtr(group.Id) : Marshal.StringToHGlobalUni(group.Name); }
    static void ReleaseName(Group group, IntPtr name) { if(group.Name != null) Marshal.FreeHGlobal(name); }
    static byte[] ReadResource(IntPtr module, int type, IntPtr name, ushort language) {
        IntPtr resource=FindResourceExW(module,new IntPtr(type),name,language); Require(resource!=IntPtr.Zero,"FindResource");
        uint size=SizeofResource(module,resource); byte[] bytes=new byte[size];
        IntPtr loaded=LoadResource(module,resource); Require(loaded!=IntPtr.Zero,"LoadResource");
        Marshal.Copy(LockResource(loaded),bytes,0,checked((int)size)); return bytes;
    }
    public static Result Replace(string executable, string icon) {
        byte[] ico=File.ReadAllBytes(icon);
        var reader=new BinaryReader(new MemoryStream(ico));
        if(reader.ReadUInt16()!=0 || reader.ReadUInt16()!=1) throw new InvalidDataException("Not an ICO");
        int count=reader.ReadUInt16(); if(count<1 || 6+16*count>ico.Length) throw new InvalidDataException("Invalid ICO directory");
        var frames=new List<Frame>();
        for(int i=0;i<count;i++) {
            var frame=new Frame(); frame.Width=reader.ReadByte(); frame.Height=reader.ReadByte(); frame.Colors=reader.ReadByte(); reader.ReadByte();
            frame.Planes=reader.ReadUInt16(); frame.Bits=reader.ReadUInt16(); uint length=reader.ReadUInt32(),offset=reader.ReadUInt32();
            if((ulong)offset+length>(ulong)ico.Length || length==0) throw new InvalidDataException("Invalid ICO frame");
            frame.Data=new byte[length]; Buffer.BlockCopy(ico,checked((int)offset),frame.Data,0,checked((int)length)); frames.Add(frame);
        }
        var groups=new List<Group>(); int maxId=0;
        IntPtr module=LoadLibraryExW(executable,IntPtr.Zero,0x22); Require(module!=IntPtr.Zero,"Load executable resources");
        try {
            Names iconNames=delegate(IntPtr m,IntPtr t,IntPtr name,IntPtr p) { long id=name.ToInt64(); if(id>0 && id<=65535) maxId=Math.Max(maxId,(int)id); return true; };
            EnumResourceNamesW(module,new IntPtr(3),iconNames,IntPtr.Zero);
            Names groupNames=delegate(IntPtr m,IntPtr t,IntPtr name,IntPtr p) {
                long id=name.ToInt64(); string text=id>65535 || id<0 ? Marshal.PtrToStringUni(name) : null;
                Languages languages=delegate(IntPtr lm,IntPtr lt,IntPtr ln,ushort language,IntPtr lp) { groups.Add(new Group {Id=text==null?(int)id:0,Name=text,Language=language}); return true; };
                Require(EnumResourceLanguagesW(m,t,name,languages,IntPtr.Zero),"Enumerate icon languages"); return true;
            };
            EnumResourceNamesW(module,new IntPtr(14),groupNames,IntPtr.Zero);
        } finally { FreeLibrary(module); }
        if(groups.Count==0) groups.Add(new Group {Id=1,Language=0});
        if(maxId+count>65535) throw new InvalidDataException("No icon resource IDs available");
        byte[] directory;
        using(var stream=new MemoryStream()) using(var writer=new BinaryWriter(stream)) {
            writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)count);
            for(int i=0;i<count;i++) { var f=frames[i]; writer.Write(f.Width);writer.Write(f.Height);writer.Write(f.Colors);writer.Write((byte)0);writer.Write(f.Planes);writer.Write(f.Bits);writer.Write((uint)f.Data.Length);writer.Write((ushort)(maxId+1+i)); }
            writer.Flush(); directory=stream.ToArray();
        }
        IntPtr update=BeginUpdateResourceW(executable,false); Require(update!=IntPtr.Zero,"Begin icon update");
        bool committed=false;
        try {
            foreach(ushort language in groups.Select(g=>g.Language).Distinct()) for(int i=0;i<count;i++) Require(UpdateResourceW(update,new IntPtr(3),new IntPtr(maxId+1+i),language,frames[i].Data,(uint)frames[i].Data.Length),"Write icon frame");
            foreach(var group in groups) { IntPtr name=GroupName(group);try {Require(UpdateResourceW(update,new IntPtr(14),name,group.Language,directory,(uint)directory.Length),"Write icon group");} finally {ReleaseName(group,name);} }
            Require(EndUpdateResourceW(update,false),"Commit icon resources"); committed=true;
        } finally { if(!committed) EndUpdateResourceW(update,true); }
        module=LoadLibraryExW(executable,IntPtr.Zero,0x22);Require(module!=IntPtr.Zero,"Reopen branded executable");
        try {
            foreach(var group in groups) {
                IntPtr name=GroupName(group);try {if(!ReadResource(module,14,name,group.Language).SequenceEqual(directory)) throw new InvalidDataException("Icon group verification failed");} finally {ReleaseName(group,name);}
                for(int i=0;i<count;i++) if(!ReadResource(module,3,new IntPtr(maxId+1+i),group.Language).SequenceEqual(frames[i].Data)) throw new InvalidDataException("Icon frame verification failed");
            }
        } finally {FreeLibrary(module);}
        return new Result {Groups=groups.Count,Frames=count,Languages=groups.Select(g=>g.Language).Distinct().Count(),Verified=true};
    }
}

/**
 * Rewrites the PE version-info resource (RT_VERSION) so Windows taskbar/tooltip,
 * file properties and future shell pick up the product name instead of "Electron".
 * Icon resources are untouched. Supplied strings are written for en-US and zh-CN
 * Unicode string tables; every existing version language block is replaced.
 */
public static class ZhongshuoNativeVersion {
    delegate bool Languages(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool EnumResourceLanguagesW(IntPtr module, IntPtr type, IntPtr name, Languages callback, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResourceW(string file, bool deleteExisting);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResourceW(IntPtr update, bool discard);
    static void Require(bool ok, string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static void U16(List<byte> b, ushort v) { b.Add((byte)(v & 0xFF)); b.Add((byte)(v >> 8)); }
    static void U32(List<byte> b, uint v) { for(int i=0;i<4;i++) b.Add((byte)((v >> (8*i)) & 0xFF)); }
    static void Align(List<byte> b) { while(b.Count % 4 != 0) b.Add(0); }
    static int Begin(List<byte> b, ushort valueLength, ushort type) { int start=b.Count; U16(b,0); U16(b,valueLength); U16(b,type); return start; }
    static void End(List<byte> b, int start) { Align(b); int length=b.Count-start; b[start]=(byte)(length & 0xFF); b[start+1]=(byte)((length >> 8) & 0xFF); }
    static void Key(List<byte> b, string key) { b.AddRange(Encoding.Unicode.GetBytes(key + "\0")); Align(b); }
    static void StringBlock(List<byte> b, string key, string value) {
        byte[] encoded=Encoding.Unicode.GetBytes(value + "\0");
        int start=Begin(b,(ushort)encoded.Length,1);
        Key(b,key);
        b.AddRange(encoded);
        End(b,start);
    }
    static byte[] Build(string version, string numericVersion, string productName, string fileDescription, string company, string copyright, string internalName, string originalFilename, string comments, ushort language, ushort codePage) {
        string[] parts=(numericVersion ?? version).Split('.');
        uint[] nums=new uint[4];
        for(int i=0;i<4;i++) { uint parsed; nums[i]=i<parts.Length && uint.TryParse(parts[i],out parsed) ? parsed : 0; }
        var b=new List<byte>();
        int root=Begin(b,52,0);
        Key(b,"VS_VERSION_INFO");
        U32(b,0xFEEF04BD); U32(b,0x00010000);
        U32(b,(nums[0]<<16)|(nums[1]&0xFFFF)); U32(b,(nums[2]<<16)|(nums[3]&0xFFFF));
        U32(b,(nums[0]<<16)|(nums[1]&0xFFFF)); U32(b,(nums[2]<<16)|(nums[3]&0xFFFF));
        U32(b,0x0000003F); U32(b,0); U32(b,0x00040004); U32(b,1); U32(b,0); U32(b,0); U32(b,0);
        int sfi=Begin(b,0,1);
        Key(b,"StringFileInfo");
        int table=Begin(b,0,1);
        Key(b,language.ToString("X4")+codePage.ToString("X4"));
        StringBlock(b,"CompanyName",company);
        StringBlock(b,"FileDescription",fileDescription);
        StringBlock(b,"FileVersion",version);
        StringBlock(b,"InternalName",internalName);
        StringBlock(b,"LegalCopyright",copyright);
        StringBlock(b,"OriginalFilename",originalFilename);
        StringBlock(b,"ProductName",productName);
        StringBlock(b,"ProductVersion",version);
        if(!string.IsNullOrEmpty(comments)) StringBlock(b,"Comments",comments);
        End(b,table);
        End(b,sfi);
        int vfi=Begin(b,0,1);
        Key(b,"VarFileInfo");
        int var=Begin(b,4,0);
        Key(b,"Translation");
        U32(b,((uint)language<<16)|codePage);
        End(b,var);
        End(b,vfi);
        End(b,root);
        return b.ToArray();
    }
    public class Result { public bool Verified; public string ProductName; public string FileDescription; public string FileVersion; public string ProductVersion; public string OriginalFilename; public string CompanyName; public int Languages; }
    public static Result Replace(string executable, string version, string numericVersion, string productName, string fileDescription, string company, string copyright, string internalName, string originalFilename, string comments) {
        ushort[] languages=new ushort[]{0x0409,0x0804};
        var payloads=new Dictionary<ushort,byte[]>();
        foreach(ushort lang in languages) payloads[lang]=Build(version,numericVersion,productName,fileDescription,company,copyright,internalName,originalFilename,comments,lang,0x04B0);
        var existing=new List<ushort>();
        IntPtr module=LoadLibraryExW(executable,IntPtr.Zero,0x22);
        Require(module!=IntPtr.Zero,"Load executable for version enumeration");
        try {
            Languages cb=delegate(IntPtr m,IntPtr t,IntPtr n,ushort language,IntPtr p) { existing.Add(language); return true; };
            EnumResourceLanguagesW(module,new IntPtr(16),new IntPtr(1),cb,IntPtr.Zero);
        } finally { FreeLibrary(module); }
        IntPtr update=BeginUpdateResourceW(executable,false);
        Require(update!=IntPtr.Zero,"Begin version update");
        bool committed=false;
        try {
            foreach(ushort lang in existing.Distinct()) Require(UpdateResourceW(update,new IntPtr(16),new IntPtr(1),lang,null,0),"Delete old version resource");
            foreach(var pair in payloads) Require(UpdateResourceW(update,new IntPtr(16),new IntPtr(1),pair.Key,pair.Value,(uint)pair.Value.Length),"Write version resource");
            Require(EndUpdateResourceW(update,false),"Commit version resource");
            committed=true;
        } finally { if(!committed) EndUpdateResourceW(update,true); }
        var info=FileVersionInfo.GetVersionInfo(executable);
        bool matches=info.ProductName==productName && info.FileDescription==fileDescription && info.OriginalFilename==originalFilename && info.FileVersion==version;
        // Windows can briefly return an empty version resource right after commit (handle/cache flush);
        // retry before failing so a successful PE update is not misreported as a build failure.
        for(int attempt=0; !matches && attempt<25; attempt++) {
            System.Threading.Thread.Sleep(200);
            info=FileVersionInfo.GetVersionInfo(executable);
            matches=info.ProductName==productName && info.FileDescription==fileDescription && info.OriginalFilename==originalFilename && info.FileVersion==version;
        }
        if(!matches) throw new InvalidDataException("Version resource verification failed: " + info.ProductName + " | " + info.FileDescription + " | " + info.OriginalFilename + " | " + info.FileVersion);
        return new Result {Verified=true,ProductName=info.ProductName,FileDescription=info.FileDescription,FileVersion=info.FileVersion,ProductVersion=info.ProductVersion,OriginalFilename=info.OriginalFilename,CompanyName=info.CompanyName,Languages=languages.Length};
    }
}
'@
$iconResult=[ZhongshuoNativeIcon]::Replace($Executable, $Icon)
if ([string]::IsNullOrEmpty($Version)) {
  $iconResult | ConvertTo-Json -Compress
  exit 0
}
$versionResult=[ZhongshuoNativeVersion]::Replace($Executable, $Version, $NumericVersion, $ProductName, $FileDescription, $Company, $Copyright, $InternalName, $OriginalFilename, $Comments)
[pscustomobject]@{
  Groups=$iconResult.Groups; Frames=$iconResult.Frames; Languages=$iconResult.Languages; Verified=$iconResult.Verified;
  Version=$versionResult
} | ConvertTo-Json -Compress -Depth 5
