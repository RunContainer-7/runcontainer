$base = Join-Path $env:APPDATA 'RunContainer'
$errorLog = Join-Path $base 'runcontainer-error.log'
$consoleLog = Join-Path $base 'runcontainer-console.log'

Write-Output "APPDATA=$base"

if (Test-Path $errorLog) {
  Write-Output '--- ERROR LOG ---'
  Get-Content $errorLog -Tail 50
} else {
  Write-Output 'NO_ERROR_LOG'
}

if (Test-Path $consoleLog) {
  Write-Output '--- CONSOLE LOG ---'
  Get-Content $consoleLog -Tail 50
} else {
  Write-Output 'NO_CONSOLE_LOG'
}
