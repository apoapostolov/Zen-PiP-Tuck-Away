# Installs (or removes) the hidden autostart entry for the PiP Tuck Away
# hotkey helper. The helper gives Ctrl+Alt+T a system-wide registration, which
# a browser mod cannot make for itself.
#
#   powershell -NoProfile -File tools\install-autostart.ps1
#   powershell -NoProfile -File tools\install-autostart.ps1 -Remove
#
# The entry is a small .vbs in the user Startup folder, so it runs at logon and
# never shows a console window.

[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$helper = Join-Path $PSScriptRoot 'pip-hotkey.pyw'
$stateDir = Join-Path $env:LOCALAPPDATA 'pip-tuck-away'
$startup = [Environment]::GetFolderPath('Startup')
$entry = Join-Path $startup 'pip-hotkey.vbs'

if ($Remove) {
    if (Test-Path $entry) {
        Remove-Item $entry -Force
    }
    if (-not (Test-Path $stateDir)) {
        New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    }
    New-Item -ItemType File -Force -Path (Join-Path $stateDir 'stop') | Out-Null
    Write-Host 'Removed the autostart entry and asked the helper to exit.'
    return
}

if (-not (Test-Path $helper)) {
    throw "Helper not found at $helper"
}

$pythonw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pythonw) {
    $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if ($python) {
        $candidate = Join-Path (Split-Path $python) 'pythonw.exe'
        if (Test-Path $candidate) {
            $pythonw = $candidate
        }
    }
}
if (-not $pythonw -or -not (Test-Path $pythonw)) {
    throw 'pythonw.exe was not found on PATH. Install Python 3, then run this again.'
}

$vbs = (@'
' Starts the PiP Tuck Away hotkey helper with no console window.
Set sh = CreateObject("WScript.Shell")
sh.Run "{0} ""{1}""", 0, False
'@) -f $pythonw, $helper

Set-Content -Path $entry -Value $vbs -Encoding ASCII

if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
}
$stop = Join-Path $stateDir 'stop'
if (Test-Path $stop) {
    Remove-Item $stop -Force
}

Start-Process -FilePath $pythonw -ArgumentList "`"$helper`"" -WindowStyle Hidden
Start-Sleep -Milliseconds 700

$status = Join-Path $stateDir 'status.json'
if (Test-Path $status) {
    Write-Host "Helper status: $(Get-Content $status -Raw)"
} else {
    Write-Host 'Helper started, but no status file yet. Check again in a moment.'
}
Write-Host "Autostart entry: $entry"
Write-Host "Python: $pythonw"
