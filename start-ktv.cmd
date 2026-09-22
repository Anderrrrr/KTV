@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node.exe >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node.exe"

if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
  echo.
  echo [ERROR] Node.js was not found.
  echo Please install Node.js 22.13 or newer from https://nodejs.org/
  echo Then run this file again.
  echo.
  pause
  exit /b 1
)

echo Starting KTV...
"%NODE_EXE%" server.js
echo.
echo KTV has stopped. If an error is shown above, please send it to me.
pause
