@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-xtele.ps1"
set "xtele_result=%errorlevel%"
echo.
if "%xtele_result%"=="0" echo Installation and compilation verified. Trading was NOT enabled.
if not "%xtele_result%"=="0" echo Review the messages above. Trading was NOT enabled.
pause
exit /b %xtele_result%
