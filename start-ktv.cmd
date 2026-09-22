@echo off
setlocal
cd /d "%~dp0"

REM Different PCs have Node.js installed in different places (PATH, the
REM official installer, nvm-windows, ...), and some may still have an old
REM version. This checks each candidate's actual version and only uses one
REM new enough for the app's requirement (Node >= 22.5, needed for the
REM built-in node:sqlite module), instead of blindly using the first
REM "node.exe" found.
set "REQUIRED_MAJOR=22"
set "REQUIRED_MINOR=5"
set "NODE_EXE="

call :check_candidate "node.exe"
if defined NODE_EXE goto :found

call :check_candidate "%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto :found

call :check_candidate "%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE_EXE goto :found

if defined NVM_SYMLINK call :check_candidate "%NVM_SYMLINK%\node.exe"
if defined NODE_EXE goto :found

if defined NVM_HOME (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%NVM_HOME%\v*" 2^>nul') do (
    if not defined NODE_EXE call :check_candidate "%NVM_HOME%\%%D\node.exe"
  )
)
if defined NODE_EXE goto :found

call :check_candidate "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if defined NODE_EXE goto :found

echo.
echo [ERROR] Could not find Node.js %REQUIRED_MAJOR%.%REQUIRED_MINOR% or newer.
echo Please install Node.js 22 or newer from https://nodejs.org/
echo Then run this file again.
echo.
pause
exit /b 1

:found
echo Starting KTV using "%NODE_EXE%" ...
"%NODE_EXE%" server.js
echo.
echo KTV has stopped. If an error is shown above, please send it to me.
pause
exit /b 0

:check_candidate
set "CANDIDATE=%~1"
"%CANDIDATE%" -v >"%TEMP%\ktv-node-ver.txt" 2>nul
if errorlevel 1 exit /b 0
set "RAWVER="
set /p RAWVER=<"%TEMP%\ktv-node-ver.txt"
del "%TEMP%\ktv-node-ver.txt" >nul 2>nul
if not defined RAWVER exit /b 0
set "RAWVER=%RAWVER:v=%"
set "CAND_MAJOR="
set "CAND_MINOR="
for /f "tokens=1,2 delims=." %%a in ("%RAWVER%") do (
  set "CAND_MAJOR=%%a"
  set "CAND_MINOR=%%b"
)
echo %CAND_MAJOR%|findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 exit /b 0
echo %CAND_MINOR%|findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 set "CAND_MINOR=0"
set /a CAND_SCORE=CAND_MAJOR*1000+CAND_MINOR
set /a REQUIRED_SCORE=REQUIRED_MAJOR*1000+REQUIRED_MINOR
if %CAND_SCORE% GEQ %REQUIRED_SCORE% set "NODE_EXE=%CANDIDATE%"
exit /b 0
