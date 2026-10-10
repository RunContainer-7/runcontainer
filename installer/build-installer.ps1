$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$buildDir = Join-Path $projectRoot 'out\RunContainer-win32-x64'
$installerDir = Join-Path $projectRoot 'out\installer'

if (-not (Test-Path $buildDir)) {
  throw "Build output folder not found: $buildDir"
}

New-Item -ItemType Directory -Path $installerDir -Force | Out-Null

$issPath = Join-Path $projectRoot 'installer\RunContainer.iss'
if (-not (Test-Path $issPath)) {
  throw "Inno Setup script not found: $issPath"
}

$innoCompiler = $null
foreach ($candidate in @(
  'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
  'C:\Program Files\Inno Setup 6\ISCC.exe',
  'C:\Program Files (x86)\Inno Setup 5\ISCC.exe',
  'C:\Program Files\Inno Setup 5\ISCC.exe'
)) {
  if (Test-Path $candidate) {
    $innoCompiler = $candidate
    break
  }
}

if (-not $innoCompiler) {
  throw 'Inno Setup compiler (ISCC.exe) was not found. Install Inno Setup 5/6 first.'
}

& $innoCompiler $issPath
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup failed with exit code $LASTEXITCODE"
}

Write-Host 'Installer build completed.'
