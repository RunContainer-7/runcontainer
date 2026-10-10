$ErrorActionPreference = 'Stop'

$source = 'C:\RunContainer\runcontainer\out\RunContainer-win32-x64'
$packageRoot = 'C:\RunContainer\runcontainer\out\RunContainer-Share'
$zipPath = 'C:\RunContainer\runcontainer\out\RunContainer-OneClick-Share.zip'

if (Test-Path $packageRoot) {
  Remove-Item $packageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'RunContainer-win32-x64') -Force | Out-Null

Copy-Item -Path (Join-Path $source '*') -Destination (Join-Path $packageRoot 'RunContainer-win32-x64') -Recurse -Force
Copy-Item -Path 'C:\RunContainer\runcontainer\out\RunContainer-Share\RunContainer.vbs' -Destination $packageRoot -Force

if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}
Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $zipPath -Force

Get-Item $zipPath | Select-Object Name,Length,LastWriteTime
