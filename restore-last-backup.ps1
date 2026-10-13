$ErrorActionPreference = 'Stop'
$receipt = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installation-receipt.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $receipt.backup) { throw 'No installation backup was recorded.' }
& (Join-Path $PSScriptRoot 'install-update.ps1') -RestoreBackup $receipt.backup
