@echo off
rem Zhongshuo DAILY desktop launcher (ASCII only - codepage safe). No seed, no fake runtime.
setlocal EnableDelayedExpansion
set PKG=%~dp0
set APP_DIR=%PKG%server-data
if not exist "%APP_DIR%" mkdir "%APP_DIR%"
rem Clean parent-environment ZS_* overrides: this package owns its runtime.
rem Engineering pass-through (verification only, documented): ZS_DEV25_DEBUG_PORT (CDP),
rem ZS_PICK_FOLDER / ZS_PICK_FOLDER_FILE (dir-picker), ZS_SAVEAS_AUTO_DIR (isolated save verification).
for /f "delims== tokens=1" %%V in ('set ZS_ 2^>nul') do (
  if /i not "%%V"=="ZS_DEV25_DEBUG_PORT" if /i not "%%V"=="ZS_PICK_FOLDER" if /i not "%%V"=="ZS_PICK_FOLDER_FILE" if /i not "%%V"=="ZS_SAVEAS_AUTO_DIR" if /i not "%%V"=="ZS_R78_ENGINEERING_TOKEN" if /i not "%%V"=="ZS_DAEMON_ENTRY" set "%%V="
)
rem R78 explicit engineering entry: own isolated root, nonce marker, debug port, no bundled fixture.
if not "!ZS_R78_ENGINEERING_TOKEN!"=="" (
  if "!ZS_DEV25_DEBUG_PORT!"=="" exit 9
  powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; try { $root=[IO.Path]::GetFullPath($env:APP_DIR).TrimEnd([char]92); $entry=[IO.Path]::GetFullPath($env:ZS_DAEMON_ENTRY); $m=Get-Content -LiteralPath (Join-Path $root 'engineering-r78.json') -Raw | ConvertFrom-Json; if ($m.token -cne $env:ZS_R78_ENGINEERING_TOKEN -or [IO.Path]::GetFullPath($m.appDataDir).TrimEnd([char]92) -ine $root -or [IO.Path]::GetFullPath($m.daemonEntry) -ine $entry -or -not $entry.StartsWith(($root+[char]92+'engineering'+[char]92),[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) { exit 9 }; exit 0 } catch { exit 9 }"
  if errorlevel 1 (
    echo Engineering root identity mismatch. Startup refused.
    exit 9
  )
  set ZS_APP_MODE=fake-sim
) else (
  set "ZS_DAEMON_ENTRY="
)
rem Pipe name is generated once per data root (package copies never collide).
if not exist "%APP_DIR%\pipe-name.txt" (
  set "PIPE_TAG="
  for /f %%G in ('powershell.exe -NoProfile -NonInteractive -Command "[guid]::NewGuid().ToString()"') do set "PIPE_TAG=%%G"
  if not defined PIPE_TAG (
    echo Failed to generate independent pipe identity.
    exit /b 1
  )
  >"%APP_DIR%\pipe-name.txt" echo zs-daily-!PIPE_TAG!
)
set /p PIPE_SHORT=<"%APP_DIR%\pipe-name.txt"
set PIPE_NAME=\\.\pipe\!PIPE_SHORT!
set ZS_APP_DATA=%APP_DIR%
rem Daily runtime: member bindings take priority (configured per member in the app).
rem Global default = claude channel; no fake, no dispatch guard, no demo bootstrap.
set ZS_RUNTIME=claude
set ZS_PIPE_NAME=!PIPE_NAME!
echo Starting Zhongshuo (daily desktop - real runtime config, no demo data)...
if not "%ZS_DEV25_DEBUG_PORT%"=="" (
  start "ZhongshuoDaily" "%PKG%ZhongshuoDual\electron.exe" --remote-debugging-port=%ZS_DEV25_DEBUG_PORT%
) else (
  start "ZhongshuoDaily" "%PKG%ZhongshuoDual\electron.exe"
)
echo.
echo Data root: %APP_DIR%   (shown in Settings - Data and draft storage)
echo First run: open your own project folder from the welcome screen.
echo Keep this console open. Closing the app window exits the app.
pause
endlocal
