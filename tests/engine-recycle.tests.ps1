[CmdletBinding()]
param(
    [switch] $Child,
    [string] $FixtureRoot
)
$ErrorActionPreference = 'Stop'

if ($Child) {
    # Execute the production document loop and its real outer finally. Only the
    # COM object is replaced; no isolation helper, COM activation, or UI is run.
    $converterPath = Join-Path $PSScriptRoot '../scripts/convert-hwp.ps1'
    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($converterPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw 'Production converter did not parse.' }
    $outerTry = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
    if ($outerTry.Count -ne 1) { throw 'Expected exactly one production outer try block.' }
    $loops = @($outerTry[0].Body.Statements | Where-Object { $_ -is [Management.Automation.Language.ForStatementAst] })
    if ($loops.Count -ne 1 -or -not $outerTry[0].Finally) { throw 'Production document loop or cleanup block was not found.' }
    . (Join-Path $PSScriptRoot '../scripts/conversion-functions.ps1')

    $eventPath = Join-Path $FixtureRoot 'events.jsonl'
    $script:eventWriter = New-Object IO.StreamWriter($eventPath, $false, (New-Object Text.UTF8Encoding $false))
    $script:eventWriter.AutoFlush = $true
    $script:cancelPath = Join-Path $FixtureRoot 'cancel'
    $hwp = New-Object PSObject
    $hwp | Add-Member ScriptMethod Open {
        param($file, $format, $options)
        Write-ConversionEvent @{type='test-hwp-open';inputPath=$file}
        return $true
    }
    $hwp | Add-Member ScriptMethod SaveAs {
        param($file, $format, $options)
        Write-ConversionEvent @{type='test-hwp-save';outputPath=$file;outputKind=$format}
        # Reproduce the observed failure: success is returned without any file.
        return $true
    }
    $hwp | Add-Member ScriptMethod Clear {
        param($mode)
        Write-ConversionEvent @{type='test-hwp-clear';mode=$mode}
        return $true
    }
    $hwp | Add-Member ScriptMethod Quit {
        Write-ConversionEvent @{type='test-hwp-quit'}
        return $true
    }
    # Fixture state exercises the existing verified-engine cleanup branch. This
    # value is not an observation or assertion about a real desktop or COM object.
    $isolationVerified = $true
    $tasks = @(
        [pscustomobject]@{
            id='missing-pdf';inputPath=(Join-Path $FixtureRoot 'first.hwp');inputName='first.hwp'
            targets=@('pdf','hwpx')
            plannedOutputPaths=[pscustomobject]@{pdf=(Join-Path $FixtureRoot 'first.pdf');hwpx=(Join-Path $FixtureRoot 'first.hwpx')}
        },
        [pscustomobject]@{
            id='must-remain-unstarted';inputPath=(Join-Path $FixtureRoot 'later.hwp');inputName='later.hwp'
            targets=@('pdf')
            plannedOutputPaths=[pscustomobject]@{pdf=(Join-Path $FixtureRoot 'later.pdf')}
        }
    )
    $summary = @{total=$tasks.Count;succeeded=0;failed=0;pdf=0;hwpx=0}
    $pendingTemporaryPaths = New-Object 'System.Collections.Generic.List[string]'
    $actualCode = 'try {' + [Environment]::NewLine + $loops[0].Extent.Text + [Environment]::NewLine +
        '} finally ' + $outerTry[0].Finally.Extent.Text
    & ([scriptblock]::Create($actualCode))
    throw 'Expected production exit 75 was not reached.'
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('hangul-engine-recycle-tests-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$process = $null
try {
    [IO.File]::WriteAllText((Join-Path $testRoot 'first.hwp'), 'mock input one')
    [IO.File]::WriteAllText((Join-Path $testRoot 'later.hwp'), 'mock input two')
    $executable = Join-Path $PSHOME 'powershell.exe'
    if (-not [IO.File]::Exists($executable)) { $executable = Join-Path $PSHOME 'pwsh.exe' }
    $arguments = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-Child','-FixtureRoot',('"' + $testRoot + '"'))
    $process = Start-Process -FilePath $executable -ArgumentList $arguments -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $testRoot 'stdout.txt') -RedirectStandardError (Join-Path $testRoot 'stderr.txt')
    $ownedProcessHandle = $process.Handle
    if (-not $process.WaitForExit(15000)) {
        # This is the owned mock-only child; no HWP or desktop process is involved.
        $process.Kill()
        $process.WaitForExit()
        throw 'Mock converter loop exceeded its 15-second test deadline.'
    }
    $process.Refresh()
    if ($process.ExitCode -ne 75) {
        $stderr = [IO.File]::ReadAllText((Join-Path $testRoot 'stderr.txt'))
        throw "Production recovery branch exited $($process.ExitCode), expected 75. $stderr"
    }
    $events = @(Get-Content -LiteralPath (Join-Path $testRoot 'events.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    $types = @($events | ForEach-Object { $_.type })
    $starts = @($events | Where-Object { $_.type -eq 'file-start' })
    $recycles = @($events | Where-Object { $_.type -eq 'worker-recycle' })
    if ($starts.Count -ne 1 -or $starts[0].taskId -ne 'missing-pdf') { throw 'The loop started an unexpected document.' }
    if ($recycles.Count -ne 1 -or $recycles[0].taskId -ne 'missing-pdf' -or $recycles[0].code -ne 'PDF_OUTPUT_MISSING') { throw 'Expected production recycle event was missing.' }
    if (@($events | Where-Object { $_.type -in @('file-error','file-complete','output-complete','complete','fatal') }).Count -ne 0) { throw 'Recovery emitted a terminal or published-output event.' }
    $saves = @($events | Where-Object { $_.type -eq 'test-hwp-save' })
    if ($saves.Count -ne 1 -or $saves[0].outputKind -ne 'PDF') { throw 'The loop attempted an extra output after the missing PDF.' }
    $clearIndex = [Array]::IndexOf($types, 'test-hwp-clear')
    $recycleIndex = [Array]::IndexOf($types, 'worker-recycle')
    $quitIndex = [Array]::IndexOf($types, 'test-hwp-quit')
    if ($clearIndex -lt 0 -or $recycleIndex -le $clearIndex -or $quitIndex -le $recycleIndex) { throw 'Actual Clear, recycle, and finally/Quit did not execute in order.' }
    if (@($events | Where-Object { $_.type -eq 'test-hwp-clear' }).Count -ne 1 -or @($events | Where-Object { $_.type -eq 'test-hwp-quit' }).Count -ne 1) { throw 'Cleanup did not run exactly once.' }
    if (@(Get-ChildItem -LiteralPath $testRoot -File | Where-Object { $_.Extension -in @('.pdf','.hwpx') }).Count -ne 0) { throw 'Missing-output recovery unexpectedly published a result.' }
    if ([IO.File]::ReadAllText((Join-Path $testRoot 'first.hwp')) -ne 'mock input one' -or [IO.File]::ReadAllText((Join-Path $testRoot 'later.hwp')) -ne 'mock input two') { throw 'An original input changed.' }
    Write-Output 'PASS actual converter loop: missing PDF -> Clear -> worker-recycle -> finally/Quit -> exit 75'
    Write-Output 'PASS no terminal outcome, no extra document/output, originals preserved'
    Write-Output '2 recovery-loop checks passed. Real save validation and event writer ran; HWP COM and UI were not started.'
}
finally {
    if ($process) { $process.Dispose() }
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ([IO.Path]::GetDirectoryName($resolvedTestRoot).TrimEnd('\') -eq $tempRoot.TrimEnd('\') -and
        [IO.Path]::GetFileName($resolvedTestRoot).StartsWith('hangul-engine-recycle-tests-', [StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
