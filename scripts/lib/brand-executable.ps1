param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
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
'@
[ZhongshuoNativeIcon]::Replace($Executable, $Icon) | ConvertTo-Json -Compress
