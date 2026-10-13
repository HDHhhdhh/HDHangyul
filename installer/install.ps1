[CmdletBinding()]
param(
    [string] $InstallRoot,
    [switch] $NoLaunch,
    [switch] $NoShortcut
)

$ErrorActionPreference = 'Stop'
$productName = '한귤변환기'
$version = '0.2.4'
$payloadPath = Join-Path $PSScriptRoot 'payload.zip'
$payloadHashPath = Join-Path $PSScriptRoot 'payload.sha256'

function Show-InstallerMessage([string] $Message, [int] $Icon = 64) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void] $shell.Popup($Message, 0, "$productName $version", $Icon)
    }
    catch { Write-Host $Message }
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw '64비트 Windows가 필요합니다.'
    }
    if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
        $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\HWPX PDF Converter\hangul-converter'
    }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf) -or -not (Test-Path -LiteralPath $payloadHashPath -PathType Leaf)) {
        throw '설치 데이터가 불완전합니다.'
    }
    $expectedPayloadHash = (Get-Content -LiteralPath $payloadHashPath -Raw -Encoding ASCII).Trim().ToUpperInvariant()
    $actualPayloadHash = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash
    if ($actualPayloadHash -ne $expectedPayloadHash) {
        throw '설치 데이터의 무결성 검증에 실패했습니다.'
    }
    if (Get-Process -Name $productName -ErrorAction SilentlyContinue) {
        throw '실행 중인 한귤변환기를 닫은 뒤 설치 파일을 다시 실행하세요.'
    }

    $installParent = Split-Path -Parent $InstallRoot
    New-Item -ItemType Directory -Path $installParent -Force | Out-Null
    $token = [guid]::NewGuid().ToString('N')
    $extractRoot = Join-Path $env:TEMP ("hangul-converter-install-$token")
    $stagedRoot = "$InstallRoot.stage-$token"
    $backupRoot = "$InstallRoot.backup-$token"
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null

    try {
        Expand-Archive -LiteralPath $payloadPath -DestinationPath $extractRoot -Force
        $extractedApp = Join-Path $extractRoot 'app'
        $manifestPath = Join-Path $extractedApp 'distribution-manifest.json'
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($manifest.version -ne $version) { throw '배포본 버전이 일치하지 않습니다.' }
        foreach ($entry in $manifest.files.PSObject.Properties) {
            $candidate = Join-Path $extractedApp ($entry.Name -replace '/', '\')
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "배포 파일 누락: $($entry.Name)" }
            if ((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -ne [string] $entry.Value) {
                throw "배포 파일 검증 실패: $($entry.Name)"
            }
        }

        Move-Item -LiteralPath $extractedApp -Destination $stagedRoot
        if (Test-Path -LiteralPath $InstallRoot) { Move-Item -LiteralPath $InstallRoot -Destination $backupRoot }
        try {
            Move-Item -LiteralPath $stagedRoot -Destination $InstallRoot
        }
        catch {
            if (Test-Path -LiteralPath $backupRoot) { Move-Item -LiteralPath $backupRoot -Destination $InstallRoot }
            throw
        }
        if (Test-Path -LiteralPath $backupRoot) { Remove-Item -LiteralPath $backupRoot -Recurse -Force }
    }
    finally {
        if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
        if (Test-Path -LiteralPath $stagedRoot) { Remove-Item -LiteralPath $stagedRoot -Recurse -Force }
    }

    $exePath = Join-Path $InstallRoot "$productName.exe"
    if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { throw '설치 후 실행 파일을 찾지 못했습니다.' }

    if (-not $NoShortcut) {
        $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) "$productName.lnk"
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $exePath
        $shortcut.WorkingDirectory = $InstallRoot
        $shortcut.IconLocation = "$exePath,0"
        $shortcut.Description = "$productName $version"
        $shortcut.Save()
    }

    $hancomRegistered = Test-Path -LiteralPath 'Registry::HKEY_CLASSES_ROOT\HwpFrame.HwpObject'
    if (-not $hancomRegistered) {
        Show-InstallerMessage '설치는 완료됐지만 한컴오피스를 찾지 못했습니다. HWP/HML/HWPX 변환에는 한컴오피스가 필요합니다.' 48
    }
    if (-not $NoLaunch) { Start-Process -FilePath $exePath -WorkingDirectory $InstallRoot }
    exit 0
}
catch {
    Show-InstallerMessage ("설치하지 못했습니다.`r`n`r`n" + $_.Exception.Message) 16
    exit 1
}
