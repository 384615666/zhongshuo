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
AppComments=本地多 Agent 协同工作台。安装、升级、卸载都保留用户数据。
AppCopyright=Copyright (C) 2026 众说开源项目
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
WizardSizePercent=120
; Inno 6.6+ 默认不显示欢迎页；这里要展示品牌大图与产品说明。
DisableWelcomePage=no
; 品牌外观（R150）：多档尺寸供 Inno 按当前 DPI 自动选最近档；只改外观，不改安装逻辑。
; 品牌图由 scripts/lib/wizard-images.ps1 从根 logo.png 生成，保持 164:314 / 方形比例。
WizardImageFile=branding\wizard-large-202.png,branding\wizard-large-269.png,branding\wizard-large-336.png,branding\wizard-large-403.png,branding\wizard-large-430.png,branding\wizard-large-498.png,branding\wizard-large-534.png
WizardSmallImageFile=branding\wizard-small-58.png,branding\wizard-small-77.png,branding\wizard-small-97.png,branding\wizard-small-116.png,branding\wizard-small-124.png,branding\wizard-small-143.png,branding\wizard-small-159.png
ShowLanguageDialog=no
SetupIconFile={#BrandIcon}
UninstallDisplayName=众说
UninstallDisplayIcon={app}\resources\app\{#BrandIconName}
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
; Custom ownership checks and explicit interactive consent govern installation.
; Inno automatic close/restart stays disabled, including silent mode/uninstall.
CloseApplications=no
RestartApplications=no
AllowCancelDuringInstall=yes

[Languages]
Name: "zhcn"; MessagesFile: "compiler:Default.isl,{#SourcePath}ChineseSimplified.isl"

[Messages]
; 去掉默认安装器“工程感”：品牌化欢迎/准备/完成页，页数标题与按钮保持中文习惯。
SetupAppTitle=众说 安装程序
SetupWindowTitle=众说 安装程序
WelcomeLabel1=欢迎安装 众说
WelcomeLabel2=众说是本地多 Agent 协同工作台，%n项目、对话与任务数据都保存在本机。%n%n安装只写入程序目录，不会迁移或删除已有聊天数据；%n升级和卸载同样保留数据。
ReadyLabel1=准备安装 众说
ReadyLabel2a=点击「安装」开始；安装不需要管理员权限，也不会改动你的聊天记录。
ReadyLabel2b=安装完成后可从开始菜单或桌面打开众说。
FinishedHeadingLabel=众说 已安装完成
FinishedLabel=双击桌面或开始菜单中的「众说」即可开始。%n%n项目和聊天数据保存在本机，升级和卸载都不会删除。
FinishedLabelNoIcons=众说已安装完成。%n项目和聊天数据保存在本机，升级和卸载都不会删除。

[Tasks]
Name: "desktopicon"; Description: "在桌面创建众说快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "installer-processes.ps1"; Flags: dontcopy

[Icons]
Name: "{group}\众说"; Filename: "{app}\Zhongshuo.exe"; WorkingDir: "{app}"; IconFilename: "{app}\resources\app\{#BrandIconName}"; AppUserModelID: "com.zhongshuo.desktop.app"
Name: "{group}\众说操作手册"; Filename: "{app}\众说操作手册.html"; WorkingDir: "{app}"; IconFilename: "{app}\resources\app\{#BrandIconName}"
Name: "{group}\卸载众说"; Filename: "{uninstallexe}"; IconFilename: "{app}\resources\app\{#BrandIconName}"
Name: "{userdesktop}\众说"; Filename: "{app}\Zhongshuo.exe"; WorkingDir: "{app}"; IconFilename: "{app}\resources\app\{#BrandIconName}"; AppUserModelID: "com.zhongshuo.desktop.app"; Check: RefreshDesktopIcon

[Run]
Filename: "{app}\Zhongshuo.exe"; WorkingDir: "{app}"; Description: "打开众说"; Flags: nowait postinstall skipifsilent unchecked
Filename: "{app}\众说操作手册.html"; WorkingDir: "{app}"; Description: "打开操作手册"; Flags: shellexec nowait postinstall skipifsilent unchecked

; No [InstallDelete], [UninstallDelete], [UninstallRun] or user-data [Dirs].
; Inno removes only recorded installed files/shortcuts/its uninstall registration.

[Code]
procedure RefreshShellItem(EventId, Flags: LongWord; ItemPath: String; Reserved: LongWord);
  external 'SHChangeNotify@shell32.dll stdcall';

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    if FileExists(ExpandConstant('{userdesktop}\众说.lnk')) then
      RefreshShellItem($2000, $1005, ExpandConstant('{userdesktop}\众说.lnk'), 0);
    if FileExists(ExpandConstant('{group}\众说.lnk')) then
      RefreshShellItem($2000, $1005, ExpandConstant('{group}\众说.lnk'), 0);
  end;
end;

function RefreshDesktopIcon(): Boolean;
begin
  Result := WizardIsTaskSelected('desktopicon') or FileExists(ExpandConstant('{userdesktop}\众说.lnk'));
end;

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

function CheckInstallationProcesses(const Mode: String; ForceConsent: Boolean): Integer;
var
  Helper, Ticket, PowerShell, Arguments: String;
begin
    Helper := ExpandConstant('{tmp}\installer-processes.ps1');
    Ticket := ExpandConstant('{tmp}\zhongshuo-process-ownership.json');
    PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
    Arguments := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Helper +
      '" -InstallDir "' + RemoveBackslashUnlessRoot(ExpandConstant('{app}')) +
      '" -Mode ' + Mode + ' -TicketFile "' + Ticket + '" -TimeoutSeconds 20';
    if ForceConsent then Arguments := Arguments + ' -Consent';
    Result := 20;
    if not Exec(PowerShell, Arguments, '', SW_HIDE, ewWaitUntilTerminated, Result) then
      Result := 20;
    Log('Installation process check ' + Mode + ': ' + IntToStr(Result));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  ExtractTemporaryFile('installer-processes.ps1');
  Code := CheckInstallationProcesses('Probe', False);
  if (Code = 0) and not InstalledFilesBusy() then exit;
  Result := '无法确认众说已完全关闭，本次安装尚未更改程序文件。请从托盘正常退出众说，等待后台任务结束后重试。';
  if (Code <> 10) or WizardSilent() then exit;
  if TaskDialogMsgBox('众说正在运行',
    '继续安装需要先关闭此安装目录中的众说。正在执行的任务会停止，请先保存需要的内容。' + #13#10 +
    '是否先尝试正常关闭并继续安装？如果仍无法关闭，会另行询问是否强制关闭。',
    mbConfirmation, MB_YESNO or MB_DEFBUTTON2, ['正常关闭并继续', '取消安装'], 0) <> IDYES then exit;
  Code := CheckInstallationProcesses('Graceful', False);
  if (Code = 0) and not InstalledFilesBusy() then begin Result := ''; exit; end;
  if Code <> 10 then exit;
  if TaskDialogMsgBox('众说仍未完全关闭',
    '是否强制关闭此安装目录中已核实归属的众说及其后台进程，再继续安装？' + #13#10 +
    '强制关闭可能中断正在执行的任务、丢失未保存的内容；任务可能需要下次打开后恢复。',
    mbConfirmation, MB_YESNO or MB_DEFBUTTON2, ['强制关闭并继续安装', '取消安装'], 0) <> IDYES then exit;
  Code := CheckInstallationProcesses('Force', True);
  if Code <> 0 then exit;
  { Re-enumerate after shutdown and recheck both executable locks before Inno
    can write any installed files. A new instance or unknown owner blocks it. }
  if (CheckInstallationProcesses('Probe', False) = 0) and not InstalledFilesBusy() then
    Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  Result := not InstalledFilesBusy();
  if not Result then
    SuppressibleMsgBox('众说或后台进程仍在运行，无法安全卸载。请先正常退出并等待后台任务结束后重试。用户数据不会删除。', mbError, MB_OK, IDOK);
end;
