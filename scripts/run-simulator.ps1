$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sim = Join-Path $root 'simulator'
if (-not $env:FFMPEG_PATH) {
  $env:FFMPEG_PATH = (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue).Source
}
if (-not $env:FFMPEG_PATH) {
  throw 'FFmpeg not found. Set FFMPEG_PATH to ffmpeg.exe.'
}
Push-Location $sim
node src/server.js
Pop-Location
