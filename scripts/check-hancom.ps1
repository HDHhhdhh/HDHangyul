[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $OutputEncoding } catch { }
try {
    . (Join-Path $PSScriptRoot 'conversion-functions.ps1')
    $result = Get-HancomRegistration
    $result.type = 'hancom-check'
    $result.code = $(if ($result.ok) { 'HANCOM_REGISTERED' } else { 'HANCOM_COM_UNAVAILABLE' })
    $result.message = $(if ($result.ok) { '한글 설치 정보를 확인했습니다. 변환 시작 시 격리된 엔진을 검증합니다.' } else { $result.message })
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
}
catch {
    [Console]::Out.WriteLine((@{ok=$false;type='hancom-check';code='REGISTRY_CHECK_FAILED';message=$_.Exception.Message} | ConvertTo-Json -Compress))
    exit 1
}
