param([string]$DataFolder = '', [switch]$NoCompile)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer must run on your Windows PC with MT5.' }

function Select-Mt5Folder {
    $base = Join-Path $env:APPDATA 'MetaQuotes\Terminal'
    $found = @()
    if (Test-Path -LiteralPath $base) {
        $found = @(Get-ChildItem -LiteralPath $base -Directory | Where-Object {
            $_.Name -match '^[a-fA-F0-9]{32}$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'MQL5'))
        })
    }
    if ($found.Count -eq 1) { return $found[0].FullName }
    if ($found.Count -gt 1) {
        Write-Host 'Choose the MT5 data folder (check File > Open Data Folder in MT5):'
        for ($i = 0; $i -lt $found.Count; $i++) { Write-Host "[$($i + 1)] $($found[$i].FullName)" }
        $choice = Read-Host 'Number, or leave empty to paste a custom folder'
        $index = 0
        if ([int]::TryParse($choice, [ref]$index) -and $index -ge 1 -and $index -le $found.Count) {
            return $found[$index - 1].FullName
        }
    }
    return (Read-Host 'Paste the folder shown by MT5 > File > Open Data Folder').Trim().Trim('"')
}

if ([string]::IsNullOrWhiteSpace($DataFolder)) { $DataFolder = Select-Mt5Folder }
$DataFolder = [Environment]::ExpandEnvironmentVariables($DataFolder)
$DataFolder = (Resolve-Path -LiteralPath $DataFolder).Path
if (-not (Test-Path -LiteralPath (Join-Path $DataFolder 'MQL5') -PathType Container)) {
    throw 'This is not an MT5 data folder: MQL5 was not found. Nothing was installed.'
}
$expert = Join-Path $DataFolder 'MQL5\Experts\xtele\xtele.mq5'
$compiled = [IO.Path]::ChangeExtension($expert, '.ex5')
if (Test-Path -LiteralPath $compiled) {
    throw 'A compiled xtele already exists. Automatic replacement was stopped. Review an update manually in MetaEditor.'
}
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$files = @(
    'MQL5\Experts\xtele\xtele.mq5',
    'MQL5\Experts\xtele\XgoldExecutionRules.mqh',
    'MQL5\Scripts\xtele\xtele-selftest.mq5',
    'MQL5\Scripts\xtele\XgoldExecutionRules.mqh',
    'MQL5\Presets\xtele.set'
)
# Validate the complete bundle before changing any destination file.
foreach ($relative in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $relative) -PathType Leaf)) {
        throw "Bundle is incomplete: $relative. Extract the ZIP first. Nothing was installed."
    }
}
foreach ($relative in $files) {
    $destination = Join-Path $DataFolder $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    if (Test-Path -LiteralPath $destination) { Copy-Item -LiteralPath $destination -Destination "$destination.bak.$stamp" }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $relative) -Destination $destination -Force
}
Write-Host "xtele source and DISABLED preset copied into: $DataFolder"

$editors = @()
$originFile = Join-Path $DataFolder 'origin.txt'
if (Test-Path -LiteralPath $originFile) {
    $origin = (Get-Content -LiteralPath $originFile -Raw).Trim().Trim('"')
    $editors += Join-Path $origin 'metaeditor64.exe'
    $editors += Join-Path $origin 'metaeditor.exe'
}
$editors += Join-Path $DataFolder 'metaeditor64.exe'
$editors += Join-Path $DataFolder 'metaeditor.exe'
$editor = @($editors | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
$compileOk = $false
if (-not $NoCompile -and $editor.Count -eq 1) {
    $compileOk = $true
    foreach ($source in @($expert, (Join-Path $DataFolder 'MQL5\Scripts\xtele\xtele-selftest.mq5'))) {
        $log = "$source.compile.log"
        if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log }
        $started = [DateTime]::UtcNow
        $process = Start-Process -FilePath $editor[0] -ArgumentList @("/compile:`"$source`"", "/log:`"$log`"") -PassThru
        if (-not $process.WaitForExit(60000)) {
            Write-Warning 'Compilation did not finish in 60 seconds. No process was killed. Inspect MetaEditor manually.'
            $compileOk = $false
            break
        }
        $output = [IO.Path]::ChangeExtension($source, '.ex5')
        $report = if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Raw } else { '' }
        if (-not (Test-Path -LiteralPath $output) -or
            (Get-Item -LiteralPath $output).LastWriteTimeUtc -lt $started.AddSeconds(-2) -or
            $report -notmatch '\b0 errors?\b') {
            Write-Warning "Compile was NOT verified. Open this source and press F7: $source"
            Write-Host "Compiler log, if available: $log"
            $compileOk = $false
        }
    }
}
if ($compileOk) {
    Write-Host 'xtele and its no-order self-test compiled successfully.' -ForegroundColor Green
} else {
    Write-Warning 'SOURCE ONLY / compilation not verified. Compile xtele.mq5 and xtele-selftest.mq5 in MetaEditor (F7).'
}
Write-Host 'Next: run the no-order self-test, load Presets\xtele.set, and set your own ExpectedAccountLogin.'
Write-Host 'The preset keeps Enabled=false and AllowRealAccount=false. No chart was attached and no trading settings were changed.'
Write-Host 'Use a hedging DEMO account first. Remove the previous EA from the chart before attaching xtele.'
if (-not $compileOk) { exit 2 }
