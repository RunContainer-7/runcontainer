$ErrorActionPreference = 'Stop'

$targets = @(
  'C:\RunContainer\runcontainer\out\RunContainer-win32-x64\resources\app\build\index.html',
  'C:\RunContainer\runcontainer\out\RunContainer-win32-x64\resources\app\build\static\js\runtime-main.1a6981d9.js',
  'C:\RunContainer\runcontainer\out\RunContainer-win32-x64\resources\app\build\build\index.html',
  'C:\RunContainer\runcontainer\out\RunContainer-win32-x64\resources\app\build\build\static\js\runtime-main.5364d7ce.js'
)

foreach ($file in $targets) {
  if (-not (Test-Path $file)) { continue }
  $content = [System.IO.File]::ReadAllText($file)
  $content = $content.Replace('/static/css/main.a1f5b09c.chunk.css', './static/css/main.a1f5b09c.chunk.css')
  $content = $content.Replace('/static/css/main.f91d811e.chunk.css', './static/css/main.f91d811e.chunk.css')
  $content = $content.Replace('/static/js/2.9ec93c67.chunk.js', './static/js/2.9ec93c67.chunk.js')
  $content = $content.Replace('/static/js/2.638f9dad.chunk.js', './static/js/2.638f9dad.chunk.js')
  $content = $content.Replace('/static/js/main.6874bf70.chunk.js', './static/js/main.6874bf70.chunk.js')
  $content = $content.Replace('/static/js/main.414b3892.chunk.js', './static/js/main.414b3892.chunk.js')
  $content = $content.Replace('i.p="/"', 'i.p="./"')
  [System.IO.File]::WriteAllText($file, $content)
  Write-Output "PATCHED $file"
}
