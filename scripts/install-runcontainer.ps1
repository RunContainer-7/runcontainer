param(
  [string]$Source = (Join-Path $PSScriptRoot '..\out\RunContainer-win32-x64'),
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\RunContainer",
  [switch]$DesktopShortcut,
  [switch]$StartMenuShortcut
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Source)) {
  throw "Build output folder not found: $Source"
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $Source '*') -Destination $InstallDir -Recurse -Force

$exePath = Join-Path $InstallDir 'RunContainer.exe'
if (-not (Test-Path $exePath)) {
  throw "Expected executable not found: $exePath"
}

function New-Shortcut {
  param(
    [string]$TargetPath,
    [string]$LinkPath,
    [string]$Description
  )

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($LinkPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.WorkingDirectory = Split-Path $TargetPath -Parent
  $shortcut.IconLocation = "$TargetPath,0"
  $shortcut.Description = $Description
  $shortcut.Save()
}

if ($DesktopShortcut -or $StartMenuShortcut) {
  if ($DesktopShortcut) {
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $desktopLink = Join-Path $desktopPath 'RunContainer.lnk'
    New-Shortcut -TargetPath $exePath -LinkPath $desktopLink -Description 'RunContainer'
  }

  if ($StartMenuShortcut) {
    $startMenuPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\RunContainer'
    New-Item -ItemType Directory -Path $startMenuPath -Force | Out-Null
    $startMenuLink = Join-Path $startMenuPath 'RunContainer.lnk'
    New-Shortcut -TargetPath $exePath -LinkPath $startMenuLink -Description 'RunContainer'
  }
}

Write-Host "Installed RunContainer to $InstallDir"
