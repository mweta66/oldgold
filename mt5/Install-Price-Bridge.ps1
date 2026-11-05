$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$Python = Get-Command py -ErrorAction SilentlyContinue
$PythonArgs = @('-3')
if (-not $Python) { $Python = Get-Command python -ErrorAction SilentlyContinue; $PythonArgs = @() }
if (-not $Python) { throw 'Install Python 3 for Windows, then run this file again.' }
$Venv = Join-Path $PSScriptRoot '.price-venv'
if (-not (Test-Path "$Venv\Scripts\python.exe")) {
  & $Python.Source @PythonArgs -m venv $Venv
  if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment failed.' }
}
& "$Venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Price bridge dependencies could not be installed.' }
Write-Host 'Open MT5 and log in to your broker. This program sends prices only; it does not place trades.'
& "$Venv\Scripts\python.exe" -u (Join-Path $PSScriptRoot 'bridge.py') --config (Join-Path $PSScriptRoot 'config.local.json')
