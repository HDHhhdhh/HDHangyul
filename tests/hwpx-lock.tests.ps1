[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('hangul-hwpx-lock-tests-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$script:outputLock = $null

function New-ValidHwpx {
    param([string] $Path)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($Path,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($item in @(
            @('mimetype','application/hwp+zip'),
            @('Contents/content.hpf','<?xml version="1.0"?><package/>'),
            @('Contents/section0.xml','<?xml version="1.0"?><section/>')
        )) {
            $writer = New-Object IO.StreamWriter($zip.CreateEntry($item[0]).Open())
            try { $writer.Write($item[1]) } finally { $writer.Dispose() }
        }
    }
    finally { $zip.Dispose() }
}

try {
    $converterPath = Join-Path $PSScriptRoot '../scripts/convert-hwp.ps1'
    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($converterPath,[ref]$tokens,[ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw 'Production converter did not parse.' }
    $outerTry = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
    $loops = @($outerTry[0].Body.Statements | Where-Object { $_ -is [Management.Automation.Language.ForStatementAst] })
    if ($outerTry.Count -ne 1 -or $loops.Count -ne 1 -or -not $outerTry[0].Finally) { throw 'Production document loop or cleanup block was not found.' }
    . (Join-Path $PSScriptRoot '../scripts/conversion-functions.ps1')

    $inputPath = Join-Path $testRoot 'locked-source.hml'
    $outputPath = Join-Path $testRoot 'locked-source.hwpx'
    [IO.File]::WriteAllText($inputPath,'unchanged source')
    $eventPath = Join-Path $testRoot 'events.jsonl'
    $script:eventWriter = New-Object IO.StreamWriter($eventPath,$false,(New-Object Text.UTF8Encoding $false))
    $script:eventWriter.AutoFlush = $true
    $script:cancelPath = Join-Path $testRoot 'cancel'
    $hwp = New-Object PSObject
    $hwp | Add-Member ScriptMethod Open { param($file,$format,$options) Write-ConversionEvent @{type='test-hwp-open'}; return $true }
    $hwp | Add-Member ScriptMethod SaveAs {
        param($file,$format,$options)
        New-ValidHwpx $file
        # Hancom's observed sharing mode allowed existence checks but denied
        # rename/delete until Clear closed the current document.
        $script:outputLock = [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        Write-ConversionEvent @{type='test-hwp-save-locked';outputPath=$file}
        return $true
    }
    $hwp | Add-Member ScriptMethod Clear {
        param($mode)
        Write-ConversionEvent @{type='test-hwp-clear'}
        if ($script:outputLock) { $script:outputLock.Dispose(); $script:outputLock = $null }
        return $true
    }
    $hwp | Add-Member ScriptMethod Quit { Write-ConversionEvent @{type='test-hwp-quit'}; return $true }
    $isolationVerified = $true
    $pendingTemporaryPaths = New-Object 'System.Collections.Generic.List[string]'
    $tasks = @([pscustomobject]@{
        id='locked-hwpx';inputPath=$inputPath;inputName='locked-source.hml';targets=@('hwpx')
        plannedOutputPaths=[pscustomobject]@{hwpx=$outputPath}
    })
    $summary = @{total=1;succeeded=0;failed=0;pdf=0;hwpx=0}
    $actualCode = 'try {' + [Environment]::NewLine + $loops[0].Extent.Text + [Environment]::NewLine +
        '} finally ' + $outerTry[0].Finally.Extent.Text
    & ([scriptblock]::Create($actualCode))

    if (-not [IO.File]::Exists($outputPath)) { throw 'The locked HWPX was not published after Clear.' }
    Assert-OutputFile $outputPath 'hwpx'
    if ([IO.File]::ReadAllText($inputPath) -ne 'unchanged source') { throw 'The source fixture changed.' }
    if (@(Get-ChildItem -LiteralPath $testRoot -Filter '*.partial.*').Count -ne 0) { throw 'A temporary output remained.' }
    $events = @(Get-Content -LiteralPath $eventPath | ForEach-Object { $_ | ConvertFrom-Json })
    if (@($events | Where-Object { $_.type -in @('output-error','file-error','fatal') }).Count -ne 0) { throw 'The lock regression emitted an error.' }
    $types = @($events | ForEach-Object { if ($_.code) { $_.code } else { $_.type } })
    $saveIndex = [Array]::IndexOf($types,'test-hwp-save-locked')
    $clearIndex = [Array]::IndexOf($types,'test-hwp-clear')
    $validateIndex = [Array]::IndexOf($types,'OUTPUT_VALIDATION_TIMING')
    $publishIndex = [Array]::IndexOf($types,'output-complete')
    if ($saveIndex -lt 0 -or $clearIndex -le $saveIndex -or $validateIndex -le $clearIndex -or $publishIndex -le $validateIndex) {
        throw 'Production ordering was not SaveAs -> Clear -> validation -> publish.'
    }
    Write-Output 'PASS locked HWPX: SaveAs -> Clear releases handle -> validate -> publish'
    Write-Output 'PASS no Delete exception, no partial file, source preserved'
}
finally {
    if ($script:outputLock) { $script:outputLock.Dispose() }
    if ($script:eventWriter) { try { $script:eventWriter.Dispose() } catch { } }
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ([IO.Path]::GetDirectoryName($resolvedTestRoot).TrimEnd('\') -eq $tempRoot.TrimEnd('\') -and
        [IO.Path]::GetFileName($resolvedTestRoot).StartsWith('hangul-hwpx-lock-tests-',[StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
