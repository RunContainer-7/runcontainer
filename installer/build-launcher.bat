@echo off
setlocal
set OUT=%~dp0launcher.exe
where cl >nul 2>&1
if errorlevel 1 (
  echo Visual Studio Build Tools with cl.exe are required.
  echo Install them and rerun this script.
  exit /b 1
)
cl /nologo /EHsc /W4 /Fe"%OUT%" "%~dp0launcher.c"
if errorlevel 1 exit /b 1

echo Built %OUT%
