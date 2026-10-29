#ifdef Nightly
  #define ProductName "RunContainer Nightly"
  #define ProductExe "RunContainerNightly"
  #define ProductId "{{A874DA0F-8A2E-4C69-A0A8-04D727D3B248}"
  #define SetupPrefix "RunContainer-Nightly-Setup-"
#else
  #define ProductName "RunContainer"
  #define ProductExe "RunContainer"
  #define ProductId "{{62FD400C-D5A3-4ACA-9B40-A8310FCC5F26}"
  #define SetupPrefix "RunContainer-Stable-Setup-"
#endif
#ifndef MyAppVersion
#define MyAppVersion "0.7.1"
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
#ifdef Nightly
#define MyIcon "..\public\runcontainer-nightly-icon.ico"
#else
#define MyIcon "..\public\runcontainer-icon.ico"
#endif
#endif

[Setup]
AppId={#ProductId}
AppName={#ProductName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\{#ProductName}
CloseApplications=yes
RestartApplications=yes
DefaultGroupName={#ProductName}
OutputBaseFilename={#SetupPrefix}{#MyAppVersion}
SetupIconFile={#MyIcon}
UninstallDisplayIcon={app}\{#ProductExe}.exe
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir={#MyOutDir}

[Files]
Source: "{#MyAppSource}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#ProductName}"; Filename: "{app}\{#ProductExe}.exe"; IconFilename: "{app}\{#ProductExe}.exe"
Name: "{commondesktop}\{#ProductName}"; Filename: "{app}\{#ProductExe}.exe"; IconFilename: "{app}\{#ProductExe}.exe"

[Run]
Filename: "{app}\{#ProductExe}.exe"; Description: "Launch {#ProductName}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
#ifdef Nightly
// Give the installer wizard a blue identity as well as the blue executable icon.
procedure InitializeWizard();
begin
  WizardForm.Color := $00FFF4E8;
  WizardForm.WelcomeLabel1.Font.Color := $00A05A10;
  WizardForm.FinishedHeadingLabel.Font.Color := $00A05A10;
end;
#endif

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
  if not Exec(PowerShell, '-NoProfile -NonInteractive -Command "if (Get-Process -Name ''{#ProductExe}'' -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
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
    + ' & taskkill.exe /IM {#ProductExe}.exe /T /F | Out-Null;'
    + ' $deadline=(Get-Date).AddSeconds(10);'
    + ' while ((Get-Process -Name ''{#ProductExe}'') -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 250 };'
    + ' if (Get-Process -Name ''{#ProductExe}'') { exit 1 } else { exit 0 }';
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
  Exec(ExpandConstant('{sysnative}\taskkill.exe'), '/IM {#ProductExe}.exe /T /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
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
    if MsgBox('{#ProductName} is still running. Setup must close it before replacing its files.' + #13#10#13#10
      + 'Close {#ProductName} now and continue?', mbConfirmation, MB_YESNO) = IDNO then
    begin
      Result := 'Close {#ProductName} (including any error window), then run Setup again.';
      Exit;
    end;
  end;
  if not CloseRunContainer() then
    Result := 'Setup could not close {#ProductName}. End {#ProductExe}.exe in Task Manager, then run Setup again.';
end;
