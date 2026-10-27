@echo off
cd /d "%~dp0.."
".mt5-venv\Scripts\python.exe" -u "mt5\bridge.py"
pause
