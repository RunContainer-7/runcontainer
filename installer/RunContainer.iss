#ifndef MyAppVersion
#define MyAppVersion "0.7.0"
#endif
#ifndef MyAppRoot
#define MyAppRoot "C:\RunContainer\runcontainer"
#endif
// Overridden from the command line by the CI release workflow (/DMyAppSource=,
// /DMyOutDir=); the absolute defaults below are for local builds on this machine.
#ifndef MyAppSource
#define MyAppSource "C:\RunContainer\runcontainer\out\RunContainer-win32-x64"
#endif
#ifndef MyOutDir
#define MyOutDir "C:\RunContainer\runcontainer\out"
#endif
// Same icon as the app, its shortcuts and the in-app update wizard. Relative
// paths resolve against this script's directory; CI can override it.
#ifndef MyIcon
#define MyIcon "..\public\runcontainer-icon.ico"
#endif

[Setup]
AppId={{62FD400C-D5A3-4ACA-9B40-A8310FCC5F26}
AppName=RunContainer
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\RunContainer
CloseApplications=yes
RestartApplications=yes
DefaultGroupName=RunContainer
OutputBaseFilename=RunContainer-Setup-{#MyAppVersion}
SetupIconFile={#MyIcon}
UninstallDisplayIcon={app}\RunContainer.exe
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir={#MyOutDir}

[Files]
Source: "{#MyAppSource}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\RunContainer"; Filename: "{app}\RunContainer.exe"; IconFilename: "{app}\RunContainer.exe"
Name: "{commondesktop}\RunContainer"; Filename: "{app}\RunContainer.exe"; IconFilename: "{app}\RunContainer.exe"

[Run]
Filename: "{app}\RunContainer.exe"; Description: "Launch RunContainer"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
// An upgrade must not fail just because RunContainer is still open. A crashed
// copy can leave an error window that ignores a graceful close, and Setup's
// Restart Manager then aborts the whole installation with a generic message.
// Close our own process first: silently when unattended, after asking otherwise.
function RunContainerRunning(): Boolean;
var
  ResultCode: Integer;
  PowerShell: String;
begin
  Result := False;
  PowerShell := ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe');
  if not FileExists(PowerShell) then
    PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  if not FileExists(PowerShell) then
    Exit;
  if not Exec(PowerShell, '-NoProfile -NonInteractive -Command "if (Get-Process -Name ''RunContainer'' -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Exit;
  Result := ResultCode = 1;
end;

// Killing the process tree is not instant: Electron's main process can take a
// few seconds to exit, and a single check right after taskkill used to report a
// failure while the app was already closing. Wait for it instead of guessing.
function CloseRunContainer(): Boolean;
var
  ResultCode: Integer;
  PowerShell: String;
  Script: String;
begin
  PowerShell := ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe');
  if not FileExists(PowerShell) then
    PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Script := '$ErrorActionPreference=''SilentlyContinue'';'
    + ' & taskkill.exe /IM RunContainer.exe /T /F | Out-Null;'
    + ' $deadline=(Get-Date).AddSeconds(10);'
    + ' while ((Get-Process -Name ''RunContainer'') -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 250 };'
    + ' if (Get-Process -Name ''RunContainer'') { exit 1 } else { exit 0 }';
  if FileExists(PowerShell) then
  begin
    if not Exec(PowerShell, '-NoProfile -NonInteractive -Command "' + Script + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      Result := False;
      Exit;
    end;
    Result := ResultCode = 0;
    Exit;
  end;
  // No PowerShell: fall back to taskkill and give the process tree time to go.
  Exec(ExpandConstant('{sysnative}\taskkill.exe'), '/IM RunContainer.exe /T /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(5000);
  Result := not RunContainerRunning();
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not RunContainerRunning() then
    Exit;
  if not WizardSilent then
  begin
    if MsgBox('RunContainer is still running. Setup must close it before replacing its files.' + #13#10#13#10
      + 'Close RunContainer now and continue?', mbConfirmation, MB_YESNO) = IDNO then
    begin
      Result := 'Close RunContainer (including any error window), then run Setup again.';
      Exit;
    end;
  end;
  if not CloseRunContainer() then
    Result := 'Setup could not close RunContainer. End RunContainer.exe in Task Manager, then run Setup again.';
end;
