; All paths/version values are supplied by make-windows-installer.mjs.
; No data directory is created, imported, migrated, registered or deleted here.
#ifndef PayloadDir
  #error PayloadDir must be provided by the builder
#endif
#ifndef ReleaseVersion
  #error ReleaseVersion must be provided by the builder
#endif

[Setup]
AppId=com.zhongshuo.desktop
AppName=众说
AppVersion={#ReleaseVersion}
AppVerName=众说 {#ReleaseVersion}
AppPublisher=众说开源项目
AppPublisherURL=https://github.com/384615666/zhongshuo
AppSupportURL=https://github.com/384615666/zhongshuo/issues
AppComments=本地多 Agent 协同工作台。卸载保留用户数据。
DefaultDirName={localappdata}\Programs\Zhongshuo
DefaultGroupName=众说
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
DisableProgramGroupPage=yes
DisableDirPage=auto
UsePreviousAppDir=yes
UsePreviousTasks=yes
WizardStyle=modern
WizardSizePercent=110
ShowLanguageDialog=no
LicenseFile={#PayloadDir}\LICENSE
InfoBeforeFile={#PayloadDir}\安装说明.txt
SetupIconFile={#BrandIcon}
UninstallDisplayName=众说
UninstallDisplayIcon={app}\resources\app\Zhongshuo.ico
Uninstallable=yes
UninstallLogMode=append
UninstallLogging=yes
CreateUninstallRegKey=yes
VersionInfoVersion={#NumericVersion}
VersionInfoProductVersion={#NumericVersion}
VersionInfoTextVersion={#ReleaseVersion}
VersionInfoProductTextVersion={#ReleaseVersion}
VersionInfoProductName=众说
VersionInfoDescription=众说 Windows 安装程序
VersionInfoOriginalFileName=Zhongshuo-Setup-{#ReleaseVersion}-x64.exe
OutputDir={#ReleaseOutputDir}
OutputBaseFilename=Zhongshuo-Setup-{#ReleaseVersion}-x64
Compression=lzma2/normal
SolidCompression=yes
SetupLogging=yes
SetupMutex=com.zhongshuo.desktop.setup
; The app uses a per-data-root Electron single instance lock. Do not pretend it
; creates an Inno-compatible named mutex. Enable only after native alignment.
#ifdef NativeAppMutex
AppMutex={#NativeAppMutex}
#endif
; Neither silent installation nor uninstall should force-close user work.
CloseApplications=no
RestartApplications=no
AllowCancelDuringInstall=yes

[Languages]
Name: "zhcn"; MessagesFile: "compiler:Default.isl,{#SourcePath}ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "在桌面创建众说快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\众说"; Filename: "{app}\Zhongshuo.exe"; WorkingDir: "{app}"; IconFilename: "{app}\resources\app\Zhongshuo.ico"; AppUserModelID: "com.zhongshuo.desktop"
Name: "{group}\众说操作手册"; Filename: "{app}\众说操作手册.html"; WorkingDir: "{app}"
Name: "{group}\卸载众说"; Filename: "{uninstallexe}"
Name: "{userdesktop}\众说"; Filename: "{app}\Zhongshuo.exe"; WorkingDir: "{app}"; IconFilename: "{app}\resources\app\Zhongshuo.ico"; AppUserModelID: "com.zhongshuo.desktop"; Tasks: desktopicon

[Run]
Filename: "{app}\Zhongshuo.exe"; WorkingDir: "{app}"; Description: "打开众说"; Flags: nowait postinstall skipifsilent unchecked

; No [InstallDelete], [UninstallDelete], [UninstallRun] or user-data [Dirs].
; Inno removes only recorded installed files/shortcuts/its uninstall registration.

[Code]
function ProbeCreateFile(FileName: String; DesiredAccess, ShareMode: LongWord;
  SecurityAttributes: LongWord; CreationDisposition, Flags: LongWord;
  TemplateFile: THandle): THandle;
  external 'CreateFileW@kernel32.dll stdcall';
function ProbeCloseHandle(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

function FileIsLocked(const FileName: String): Boolean;
var
  Handle: THandle;
begin
  Result := False;
  if not FileExists(FileName) then exit;
  { GENERIC_WRITE, no sharing, OPEN_EXISTING. Never create, truncate or modify. }
  Handle := ProbeCreateFile(FileName, $40000000, 0, 0, 3, $80, 0);
  Result := Handle = THandle(-1);
  if not Result then ProbeCloseHandle(Handle);
end;

function InstalledFilesBusy(): Boolean;
begin
  Result := FileIsLocked(ExpandConstant('{app}\Zhongshuo.exe')) or
    FileIsLocked(ExpandConstant('{app}\resources\app\daemon\node\node.exe'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if InstalledFilesBusy() then
    Result := '众说或后台进程仍在运行，无法安全更新。请在众说中正常退出，等待后台任务结束后重新安装。本次安装尚未更改程序文件。';
end;

function InitializeUninstall(): Boolean;
begin
  Result := not InstalledFilesBusy();
  if not Result then
    SuppressibleMsgBox('众说或后台进程仍在运行，无法安全卸载。请先正常退出并等待后台任务结束后重试。用户数据不会删除。', mbError, MB_OK, IDOK);
end;
