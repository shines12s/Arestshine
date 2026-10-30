$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host 'Origin client dependencies...'
Push-Location (Join-Path $root 'origin-client')
npm ci
Pop-Location

Write-Host 'Simulator dependencies...'
Push-Location (Join-Path $root 'simulator')
npm install
Pop-Location

Write-Host 'AI Server dependencies...'
Push-Location (Join-Path $root 'ai-server')
if (-not (Test-Path '.venv\Scripts\python.exe')) {
  python -m venv .venv
}
& '.\.venv\Scripts\python.exe' -m pip install -r requirements.txt
Pop-Location

Write-Host 'Done. FFmpeg is still required for video; set FFMPEG_PATH.'
