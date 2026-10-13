[CmdletBinding()]
param([switch] $CheckOnly, [string] $RestoreBackup)
$ErrorActionPreference = 'Stop'
$installation = Join-Path $env:LOCALAPPDATA 'Programs\HWPX PDF Converter\hangul-converter'
$resources = Join-Path $installation 'resources'
$archivePath = Join-Path $resources 'app.asar'
$expectedOldHashes = @('72BE48F8F674941BC27BE1C97E93A57FCF3F92E0EDF5B06C860AEAF9229D9BA6', '742EFC00390DCAE2A3BEEBE9A73FC27CBA9AD6846A9DA2D4646D0982335FC446', '83006D7B83F1770FE2A11F463D048B49013799F86AB25F030F3F699769C33688', '27D20DA54F824CA5DBB34E9542411C4D56E196109407D278A86B4A53EA40FC2F', '3D58C9D2ADF73FED89691D8E23742C180B5457BF600608F1B020C519F0B90787')
if (-not (Test-Path -LiteralPath (Join-Path $installation '한귤변환기.exe') -PathType Leaf)) { throw '한귤변환기 설치 경로를 찾지 못했습니다.' }
if (Get-Process -Name '한귤변환기' -ErrorAction SilentlyContinue) { throw '진행 중인 변환이 끝난 뒤 한귤변환기 창을 닫고 다시 실행하세요. 실행 중인 작업은 종료하지 않았습니다.' }
if ($RestoreBackup) {
    $backupRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'backups')).TrimEnd('\') + '\'
    $restoreRoot = [IO.Path]::GetFullPath($RestoreBackup)
    if (-not $restoreRoot.StartsWith($backupRoot,[StringComparison]::OrdinalIgnoreCase)) { throw '이 업데이트가 만든 backups 폴더만 복원할 수 있습니다.' }
    $sourceResources = Join-Path $restoreRoot 'resources'
    if (-not (Test-Path -LiteralPath (Join-Path $sourceResources 'app.asar') -PathType Leaf)) { throw '백업이 불완전합니다.' }
}
else {
    $sourceResources = Join-Path $PSScriptRoot 'release\resources'
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in $manifest.PSObject.Properties) {
        $file = Join-Path $sourceResources $entry.Name
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.Value) { throw "업데이트 파일 검증 실패: $($entry.Name)" }
    }
    $currentHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($currentHash -notin $expectedOldHashes -and $currentHash -ne $manifest.'app.asar') { throw '검토 이후 설치본이 변경되었습니다. 변경된 설치본을 덮어쓰지 않았습니다.' }
}
if ($CheckOnly) { Write-Output '설치 대상과 업데이트 파일 검증 완료. 변경하지 않았습니다.'; exit 0 }
$backup = Join-Path (Join-Path $PSScriptRoot 'backups') ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$backupResources = Join-Path $backup 'resources'
New-Item -ItemType Directory -Path $backupResources -Force | Out-Null
Copy-Item -LiteralPath $archivePath -Destination (Join-Path $backupResources 'app.asar')
Copy-Item -LiteralPath (Join-Path $resources 'scripts') -Destination (Join-Path $backupResources 'scripts') -Recurse
$stagedArchive = Join-Path $resources ('app-' + [guid]::NewGuid().ToString('N') + '.asar.next')
try {
    # All source scripts are copied while the app is closed; ASAR is published last.
    foreach ($scriptFile in Get-ChildItem -LiteralPath (Join-Path $sourceResources 'scripts') -File) {
        Copy-Item -LiteralPath $scriptFile.FullName -Destination (Join-Path (Join-Path $resources 'scripts') $scriptFile.Name) -Force
    }
    Copy-Item -LiteralPath (Join-Path $sourceResources 'app.asar') -Destination $stagedArchive
    [IO.File]::Replace($stagedArchive,$archivePath,(Join-Path $backupResources 'app-replaced.asar'))
    if ((Get-FileHash -LiteralPath $archivePath).Hash -ne (Get-FileHash -LiteralPath (Join-Path $sourceResources 'app.asar')).Hash) { throw '적용 후 ASAR 검증 실패.' }
    $receipt = @{version='0.2.4';installedAt=[DateTime]::UtcNow.ToString('o');backup=$backup;archiveHash=(Get-FileHash -LiteralPath $archivePath).Hash;restored=[bool]$RestoreBackup}
    $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'installation-receipt.json') -Encoding UTF8
    Write-Output '적용 완료. 바탕화면의 한귤변환기를 다시 실행하세요.'
    Write-Output "백업: $backup"
}
catch {
    Copy-Item -LiteralPath (Join-Path $backupResources 'app.asar') -Destination $archivePath -Force
    foreach ($scriptFile in Get-ChildItem -LiteralPath (Join-Path $backupResources 'scripts') -File) {
        Copy-Item -LiteralPath $scriptFile.FullName -Destination (Join-Path (Join-Path $resources 'scripts') $scriptFile.Name) -Force
    }
    throw
}
finally { if (Test-Path -LiteralPath $stagedArchive -PathType Leaf) { Remove-Item -LiteralPath $stagedArchive -Force } }
