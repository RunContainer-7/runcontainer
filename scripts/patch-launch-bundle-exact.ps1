$ErrorActionPreference = 'Stop'

$files = @(
  'C:\RunContainer\runcontainer\out\RunContainer-win32-x64\resources\app\build\index.html',
  'C:\RunContainer\runcontainer\out\RunContainer-win32-x64\resources\app\build\static\js\runtime-main.5364d7ce.js'
)

foreach ($file in $files) {
  if (-not (Test-Path $file)) { continue }
  $content = [System.IO.File]::ReadAllText($file)
  $content = $content.Replace('/static/css/main.a1f5b09c.chunk.css', './static/css/main.a1f5b09c.chunk.css')
  $content = $content.Replace('/static/js/2.9ec93c67.chunk.js', './static/js/2.9ec93c67.chunk.js')
  $content = $content.Replace('/static/js/main.6874bf70.chunk.js', './static/js/main.6874bf70.chunk.js')
  $content = $content.Replace('i.p="/"', 'i.p="./"')
  [System.IO.File]::WriteAllText($file, $content)
  Write-Output "PATCHED $file"
}
