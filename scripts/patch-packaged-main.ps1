$ErrorActionPreference = 'Stop'

$targets = @(
  'C:\RunContainer\runcontainer\public\main.js',
  'C:\RunContainer\runcontainer\out\RunContainer-win32-x64\resources\app\public\main.js',
  'C:\RunContainer\runcontainer\build\main.js',
  'C:\RunContainer\runcontainer\out\RunContainer-win32-x64\resources\app\build\main.js'
)

foreach ($file in $targets) {
  if (-not (Test-Path $file)) { continue }
  $content = [System.IO.File]::ReadAllText($file)
  if ($content -notmatch 'did-fail-load') {
    $needle = "  mainWindow.setTitle('RunContainer');`n  mainWindow.setMenuBarVisibility(false);`n"
    $insert = "  mainWindow.setTitle('RunContainer');`n  mainWindow.setMenuBarVisibility(false);`n  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {`n    appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `did-fail-load: ${errorCode} ${errorDescription} ${validatedURL}`);`n  });`n  mainWindow.webContents.on('render-process-gone', (event, details) => {`n    appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `render-process-gone: ${JSON.stringify(details)}`);`n  });`n  mainWindow.webContents.on('unresponsive', () => {`n    appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), 'renderer unresponsive');`n  });`n  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {`n    appendLog(path.join(app.getPath('userData'), 'runcontainer-console.log'), `console:${level} ${message} (${sourceId}:${line})`);`n  });`n"
    $content = $content.Replace($needle, $insert)
  }
  [System.IO.File]::WriteAllText($file, $content)
  Write-Output "PATCHED $file"
}
