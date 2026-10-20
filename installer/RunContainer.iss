#ifndef MyAppVersion
#define MyAppVersion "0.6.0"
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

[Setup]
AppId={{62FD400C-D5A3-4ACA-9B40-A8310FCC5F26}
AppName=RunContainer
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\RunContainer
CloseApplications=yes
RestartApplications=yes
DefaultGroupName=RunContainer
OutputBaseFilename=RunContainer-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir={#MyOutDir}

[Files]
Source: "{#MyAppSource}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\RunContainer"; Filename: "{app}\RunContainer.exe"
Name: "{commondesktop}\RunContainer"; Filename: "{app}\RunContainer.exe"

[Run]
Filename: "{app}\RunContainer.exe"; Description: "Launch RunContainer"; Flags: nowait postinstall skipifsilent runasoriginaluser
