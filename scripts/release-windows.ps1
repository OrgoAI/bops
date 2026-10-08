param([switch]$SkipInstall)
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Build the Windows app on Windows 11." }
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $SkipInstall) { & npm.cmd install }
& npm.cmd run win:doctor
& npx.cmd next build
& npx.cmd electron-builder --win nsis portable --x64
Write-Host ""
Write-Host "Windows build finished. Check: $root\dist-desktop"
