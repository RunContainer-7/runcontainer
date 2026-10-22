#ifndef MyAppVersion
#define MyAppVersion "0.6.6"
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
