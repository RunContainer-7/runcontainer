@echo off
rem Double-click this file to run RunContainer from source.
rem It installs dependencies on first run, then builds and starts the app.
setlocal
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo Node.js is needed to run RunContainer from source.
  echo Install the LTS version from https://nodejs.org, then run this file again.
  goto fail
)

if not exist node_modules (
  echo Installing dependencies. This only happens the first time.
  call npm install
  if errorlevel 1 goto fail
)

rem start:desktop builds the interface first, then opens the app.
call npm run start:desktop
if errorlevel 1 goto fail
exit /b 0

:fail
echo.
echo RunContainer did not start. Read the messages above.
pause
exit /b 1
