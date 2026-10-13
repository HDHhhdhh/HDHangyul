param()
$ErrorActionPreference = 'Stop'
    . (Join-Path $PSScriptRoot '../scripts/conversion-functions.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('hangul-engine-tests-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$script:cancelPath = Join-Path $testRoot 'cancel'
$script:passed = 0
function Check([string]$Name,[scriptblock]$Test) {
    & $Test
    $script:passed++
    Write-Output "PASS $Name"
}
function Must-Throw([scriptblock]$Action) {
    $thrown = $false
    try { & $Action } catch { $thrown = $true }
    if (-not $thrown) { throw 'Expected failure did not occur.' }
}
try {
    $realFunctionsRoot = $script:conversionFunctionsRoot
    try {
        # Point at a DLL-free temporary folder so this unit check never writes
        # the real registry. The installed runtime path is verified separately.
        $script:conversionFunctionsRoot = $testRoot
        Check 'Standard security-module name remains available without registry key' {
            $moduleMock = New-Object PSObject
            $moduleMock | Add-Member ScriptMethod RegisterModule { param($kind,$name) return $kind -eq 'FilePathCheckDLL' -and $name -eq 'FilePathCheckerModuleExample' }
            if ((Register-HancomSecurityModule $moduleMock) -ne 'FilePathCheckerModuleExample') { throw 'Standard module fallback was not used.' }
        }
    }
    finally { $script:conversionFunctionsRoot = $realFunctionsRoot }
    $script:validPdf = "%PDF-1.7`n1 0 obj <<>> endobj`nstartxref`n9`n%%EOF`n"
    $valid = Join-Path $testRoot 'valid.pdf'
    [IO.File]::WriteAllText($valid,$script:validPdf)
    Check 'PDF header and completed trailer' { Assert-OutputFile $valid 'pdf' }
    Check 'Truncated PDF rejected' {
        $bad = Join-Path $testRoot 'truncated.pdf'
        [IO.File]::WriteAllText($bad,'%PDF-1.7 incomplete output data')
        Must-Throw { Assert-OutputFile $bad 'pdf' }
    }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $validHwpx = Join-Path $testRoot 'valid.hwpx'
    $zip = [IO.Compression.ZipFile]::Open($validHwpx,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($item in @(@('mimetype','application/hwp+zip'),@('Contents/content.hpf','<package/>'),@('Contents/section0.xml','<section/>'))) {
            $writer = New-Object IO.StreamWriter($zip.CreateEntry($item[0]).Open())
            try { $writer.Write($item[1]) } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
    Check 'HWPX ZIP package and XML' { Assert-OutputFile $validHwpx 'hwpx' }
    Check 'Malformed HWPX XML rejected' {
        $bad = Join-Path $testRoot 'bad.hwpx'
        [IO.File]::Copy($validHwpx,$bad)
        $archive = [IO.Compression.ZipFile]::Open($bad,[IO.Compression.ZipArchiveMode]::Update)
        try {
            $archive.GetEntry('Contents/section0.xml').Delete()
            $writer = New-Object IO.StreamWriter($archive.CreateEntry('Contents/section0.xml').Open())
            try { $writer.Write('<broken>') } finally { $writer.Dispose() }
        } finally { $archive.Dispose() }
        Must-Throw { Assert-OutputFile $bad 'hwpx' }
    }
    $mock = New-Object PSObject
    $mock | Add-Member ScriptMethod SaveAs { param($file,$format,$options) [IO.File]::WriteAllText($file,$script:validPdf); return $true }
    Check 'Atomic output publish' {
        $out = Join-Path $testRoot 'published.pdf'
        Save-ValidatedOutput $mock $out 'pdf'
        Assert-OutputFile $out 'pdf'
        if (@(Get-ChildItem -LiteralPath $testRoot -Filter '*.partial.*').Count) { throw 'Partial files remain.' }
    }
    Check 'Existing destination preserved' {
        Must-Throw { Save-ValidatedOutput $mock $valid 'pdf' }
        if ([IO.File]::ReadAllText($valid) -ne $script:validPdf) { throw 'Existing output was changed.' }
    }
    Check 'Cancellation before save' {
        [IO.File]::WriteAllText($script:cancelPath,'cancel')
        $out = Join-Path $testRoot 'cancelled.pdf'
        Must-Throw { Save-ValidatedOutput $mock $out 'pdf' }
        if ([IO.File]::Exists($out)) { throw 'Output published after cancellation.' }
        [IO.File]::Delete($script:cancelPath)
    }
    Check 'Failed SaveAs does not publish' {
        $broken = New-Object PSObject
        $broken | Add-Member ScriptMethod SaveAs { param($file,$format,$options) [IO.File]::WriteAllText($file,'partial'); return $false }
        $out = Join-Path $testRoot 'failed.pdf'
        Must-Throw { Save-ValidatedOutput $broken $out 'pdf' }
        if ([IO.File]::Exists($out) -or @(Get-ChildItem -LiteralPath $testRoot -Filter '*.partial.*').Count) { throw 'Failed file was retained.' }
    }
    Check 'Cancellation during save prevents publish' {
        $cancelMock = New-Object PSObject
        $cancelMock | Add-Member ScriptMethod SaveAs { param($file,$format,$options) [IO.File]::WriteAllText($file,$script:validPdf); [IO.File]::WriteAllText($script:cancelPath,'cancel'); return $true }
        $out = Join-Path $testRoot 'cancel-during.pdf'
        Must-Throw { Save-ValidatedOutput $cancelMock $out 'pdf' }
        if ([IO.File]::Exists($out)) { throw 'Cancelled result was published.' }
    }
    [IO.File]::Delete($script:cancelPath)
    Check 'SaveAs success without a PDF requests recoverable missing-file failure' {
        $missing = New-Object PSObject
        $missing | Add-Member ScriptMethod SaveAs { param($file,$format,$options) return $true }
        $out = Join-Path $testRoot 'missing.pdf'
        $caught = $false
        try { Save-ValidatedOutput $missing $out 'pdf' }
        catch [IO.FileNotFoundException] { $caught = $true }
        if (-not $caught -or [IO.File]::Exists($out)) { throw 'Missing PDF was not classified for fresh-engine recovery.' }
    }
    Write-Output "$script:passed engine tests passed. HWP COM was not started."
}
finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTestRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedTestRoot).StartsWith('hangul-engine-tests-')) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
