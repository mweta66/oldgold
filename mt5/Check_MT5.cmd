@echo off
cd /d "%~dp0.."
".mt5-venv\Scripts\python.exe" "mt5\check_connection.py" %*
pause
