$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Run this on Windows 11." }
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path ".env.local")) { Copy-Item ".env.example" ".env.local" }
& npm.cmd install
& npm.cmd run win:doctor
& npm.cmd run app
