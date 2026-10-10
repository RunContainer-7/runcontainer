$ErrorActionPreference = 'Stop'
$files = @(
  'C:\RunContainer\runcontainer\build\build\index.html',
  'C:\RunContainer\runcontainer\build\build\static\js\runtime-main.5364d7ce.js'
)

foreach ($file in $files) {
  $content = [System.IO.File]::ReadAllText($file)
  $content = $content.Replace('/static/css/main.f91d811e.chunk.css', './static/css/main.f91d811e.chunk.css')
  $content = $content.Replace('/static/js/2.638f9dad.chunk.js', './static/js/2.638f9dad.chunk.js')
  $content = $content.Replace('/static/js/main.414b3892.chunk.js', './static/js/main.414b3892.chunk.js')
  $content = $content.Replace('i.p="/"', 'i.p="./"')
  [System.IO.File]::WriteAllText($file, $content)
  Write-Output "PATCHED $file"
}
