[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$sourceRoot = Join-Path $env:LOCALAPPDATA 'Programs\HWPX PDF Converter\hangul-converter'
$distributionRoot = Join-Path $root 'distribution'
$workRoot = Join-Path $distributionRoot 'work'
$stageApp = Join-Path $workRoot 'app'
$installerRoot = Join-Path $root 'installer'
$payloadPath = Join-Path $workRoot 'payload.zip'
$payloadHashPath = Join-Path $workRoot 'payload.sha256'
$outputPath = Join-Path $distributionRoot '한귤변환기-0.2.4-설치.exe'
$sedPath = Join-Path $workRoot 'package.sed'

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot '한귤변환기.exe') -PathType Leaf)) { throw '설치된 한귤변환기를 찾지 못했습니다.' }
if (Get-Process -Name '한귤변환기' -ErrorAction SilentlyContinue) { throw '한귤변환기를 닫은 뒤 배포본을 만드세요.' }
$releaseManifest = Get-Content -LiteralPath (Join-Path $root 'release\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in $releaseManifest.PSObject.Properties) {
    $installedFile = Join-Path (Join-Path $sourceRoot 'resources') ($entry.Name -replace '/', '\')
    if (-not (Test-Path -LiteralPath $installedFile -PathType Leaf)) { throw "설치 파일 누락: $($entry.Name)" }
    if ((Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash -ne [string] $entry.Value) {
        throw "설치본과 검증된 릴리스가 다릅니다: $($entry.Name)"
    }
}

if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
New-Item -ItemType Directory -Path $stageApp -Force | Out-Null
Get-ChildItem -LiteralPath $sourceRoot -Force | Where-Object { $_.Name -ne 'Uninstall 한귤변환기.exe' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $stageApp -Recurse -Force
}

$fileHashes = [ordered]@{}
Get-ChildItem -LiteralPath $stageApp -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($stageApp.Length + 1).Replace('\','/')
    $fileHashes[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
}
$manifest = [ordered]@{
    product = '한귤변환기'
    version = '0.2.4'
    architecture = 'x64'
    runtimeDependencies = @('Windows 10/11 x64', '한컴오피스')
    bundledDependencies = @('Electron runtime', 'PowerShell conversion scripts', 'Hancom automation security module')
    pythonRequired = $false
    nodeRequired = $false
    files = $fileHashes
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stageApp 'distribution-manifest.json') -Encoding UTF8

Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $payloadPath) { Remove-Item -LiteralPath $payloadPath -Force }
$payloadTemp = Join-Path $distributionRoot 'payload.tmp.zip'
if (Test-Path -LiteralPath $payloadTemp) { Remove-Item -LiteralPath $payloadTemp -Force }
[IO.Compression.ZipFile]::CreateFromDirectory($workRoot, $payloadTemp, [IO.Compression.CompressionLevel]::Optimal, $false)
Move-Item -LiteralPath $payloadTemp -Destination $payloadPath
(Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash | Set-Content -LiteralPath $payloadHashPath -Encoding ASCII -NoNewline
Copy-Item -LiteralPath (Join-Path $installerRoot 'install.ps1') -Destination (Join-Path $workRoot 'install.ps1') -Force
Copy-Item -LiteralPath (Join-Path $installerRoot 'setup.cmd') -Destination (Join-Path $workRoot 'setup.cmd') -Force

$targetEscaped = $outputPath
$sourceEscaped = $workRoot.TrimEnd('\') + '\'
$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$targetEscaped
FriendlyName=한귤변환기 0.2.4 설치
AppLaunched=setup.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=setup.cmd
UserQuietInstCmd=setup.cmd
SourceFiles=SourceFiles
[Strings]
FILE0="payload.zip"
FILE1="payload.sha256"
FILE2="install.ps1"
FILE3="setup.cmd"
[SourceFiles]
SourceFiles0=$sourceEscaped
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
"@
$sed | Set-Content -LiteralPath $sedPath -Encoding Default
if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
$iexpress = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\iexpress.exe') -ArgumentList "/N /Q `"$sedPath`"" -PassThru -Wait
if ($iexpress.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) { throw "IExpress 패키지 생성 실패: $($iexpress.ExitCode)" }

$outputHash = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash
$receipt = [ordered]@{
    product = '한귤변환기'
    version = '0.2.4'
    file = (Split-Path -Leaf $outputPath)
    sizeBytes = (Get-Item -LiteralPath $outputPath).Length
    sha256 = $outputHash
    pythonRequiredOnTarget = $false
    nodeRequiredOnTarget = $false
    hancomOfficeRequired = $true
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $distributionRoot 'release.json') -Encoding UTF8
Write-Output ("Built: {0}" -f $outputPath)
Write-Output ("SHA256: {0}" -f $outputHash)
