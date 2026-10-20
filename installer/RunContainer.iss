#ifndef MyAppVersion
#define MyAppVersion "0.6.0"
#endif
#define MyAppRoot "C:\RunContainer\runcontainer"
#define MyAppSource "C:\RunContainer\runcontainer\out\RunContainer-win32-x64"
#define MyOutDir "C:\RunContainer\runcontainer\out"

[Setup]
AppName=RunContainer
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\RunContainer
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
Filename: "{app}\RunContainer.exe"; Description: "Launch RunContainer"; Flags: nowait postinstall skipifsilent
