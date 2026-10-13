[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $InputJsonPath,
    [string] $WorkerScriptPath = (Join-Path $PSScriptRoot 'convert-hwp.ps1')
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $OutputEncoding } catch { }
$session = $null
$reader = $null
$scratchDirectory = $null
$exitCode = 1
$script:tailBuffer = ''
$script:lastActivity = [Diagnostics.Stopwatch]::StartNew()
$script:forwardedResult = $false
$script:isolationAckPath = $null

function Write-LauncherEvent([hashtable] $Event) {
    $Event.timestamp = [DateTime]::UtcNow.ToString('o')
    [Console]::Out.WriteLine(($Event | ConvertTo-Json -Depth 10 -Compress))
    [Console]::Out.Flush()
}

function Request-WorkerStop([string] $Reason, [string] $PrivateCancelPath) {
    # Never write the batch-wide marker: a timeout belongs to this worker only.
    [IO.File]::WriteAllText($PrivateCancelPath, $Reason, (New-Object Text.UTF8Encoding $false))
}

function Forward-WorkerLines([switch] $Final) {
    $chunk = $script:reader.ReadToEnd()
    if ($chunk.Length -gt 0) {
        $script:lastActivity.Restart()
        $script:tailBuffer += $chunk
    }
    while (($newline = $script:tailBuffer.IndexOf("`n")) -ge 0) {
        $line = $script:tailBuffer.Substring(0, $newline).TrimEnd("`r")
        $script:tailBuffer = $script:tailBuffer.Substring($newline + 1)
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $event = $line | ConvertFrom-Json -ErrorAction Stop
        if ($event.type -eq 'isolated-process') {
            if ($event.expectedDesktop -ne $script:session.ExpectedDesktop) {
                throw 'Worker process registration contains the wrong isolated desktop.'
            }
            $script:session.RegisterIsolatedWindowProcess([int] $event.processId, [long] $event.windowHandle)
            # Child waits here until its HWND is verified and its process belongs
            # to the cleanup job. Publish atomically so a fast child cannot read
            # an empty marker or finish/Quit before registration is consumed.
            if (-not [IO.File]::Exists($script:isolationAckPath)) {
                $ackTemporary = $script:isolationAckPath + '.tmp'
                [IO.File]::WriteAllText($ackTemporary, $script:session.ExpectedDesktop, (New-Object Text.UTF8Encoding $false))
                [IO.File]::Move($ackTemporary, $script:isolationAckPath)
            }
        }
        if (@('file-complete', 'file-error', 'fatal', 'complete', 'worker-recycle') -contains $event.type) {
            $script:forwardedResult = $true
        }
        [Console]::Out.WriteLine($line)
        [Console]::Out.Flush()
    }
    if ($Final -and -not [string]::IsNullOrWhiteSpace($script:tailBuffer)) {
        throw 'Isolated worker ended with an incomplete event record.'
    }
}

try {
    if (-not [IO.Path]::IsPathRooted($InputJsonPath) -or -not (Test-Path -LiteralPath $InputJsonPath -PathType Leaf)) {
        throw 'Input JSON must be an existing absolute file path.'
    }
    $job = Get-Content -LiteralPath $InputJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $scratchDirectory = Join-Path ([IO.Path]::GetTempPath()) ('hangul-isolation-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $scratchDirectory | Out-Null
    $eventPath = Join-Path $scratchDirectory 'events.jsonl'
    $childInputPath = Join-Path $scratchDirectory 'input.json'
    $options = $job.PSObject.Properties['options']
    if ($null -eq $options -or $null -eq $options.Value) {
        $job | Add-Member -NotePropertyName options -NotePropertyValue ([pscustomobject] @{}) -Force
    }
    $cancelPath = [string] $job.options.cancelPath
    if ([string]::IsNullOrWhiteSpace($cancelPath)) { $cancelPath = Join-Path $scratchDirectory 'batch-cancel.requested' }
    if (-not [IO.Path]::IsPathRooted($cancelPath)) { throw 'Cancellation marker must be an absolute path.' }
    $privateCancelPath = Join-Path $scratchDirectory 'worker-cancel.requested'
    $job.options | Add-Member -NotePropertyName cancelPath -NotePropertyValue $privateCancelPath -Force
    $script:isolationAckPath = Join-Path $scratchDirectory 'registered.ack'
    $job.options | Add-Member -NotePropertyName isolationAckPath -NotePropertyValue $script:isolationAckPath -Force
    [IO.File]::WriteAllText($childInputPath, ($job | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
    [IO.File]::WriteAllText($eventPath, '', (New-Object Text.UTF8Encoding $false))
    $stream = New-Object IO.FileStream($eventPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = New-Object IO.StreamReader($stream, (New-Object Text.UTF8Encoding $false))

    if (-not ('HanGulConverter.DesktopIsolation' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'DesktopIsolation.cs')
    }
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powerShell -PathType Leaf)) { throw 'Windows PowerShell is missing.' }
    if (Test-Path -LiteralPath $cancelPath -PathType Leaf) { $exitCode = 130 }
    else {
        $session = [HanGulConverter.DesktopIsolation]::StartWorker($powerShell, $WorkerScriptPath, $childInputPath, $eventPath)
        $script:lastActivity.Restart()
        Write-LauncherEvent @{ type = 'log'; ok = $true; level = 'info'; code = 'ISOLATED_WORKER_STARTED'; message = 'Conversion worker started on a private Windows desktop.'; processId = $session.ProcessId; expectedDesktop = $session.ExpectedDesktop }
        $stopReason = $null
        while (-not $session.HasExited) {
            Forward-WorkerLines
            # A long PDF export can remain inside COM without emitting events.
            # Extend the inactivity deadline only for CPU use by verified HWP.
            if ($session.HasOwnedProcessCpuActivity()) { $script:lastActivity.Restart() }
            if (Test-Path -LiteralPath $cancelPath -PathType Leaf) { $stopReason = 'cancel'; break }
            if ($script:lastActivity.ElapsedMilliseconds -ge 300000) { $stopReason = 'timeout'; break }
            Start-Sleep -Milliseconds 100
        }
        if ($null -ne $stopReason) {
            # Give the worker an opportunity to close COM at its next stage boundary.
            Request-WorkerStop $stopReason $privateCancelPath
            $grace = [Diagnostics.Stopwatch]::StartNew()
            while (-not $session.HasExited -and $grace.ElapsedMilliseconds -lt 1500) {
                Forward-WorkerLines
                Start-Sleep -Milliseconds 100
            }
            if (-not $session.HasExited) { $session.Terminate() }
            $exitCode = $(if ($stopReason -eq 'cancel') { 130 } else { 124 })
            if ($stopReason -eq 'timeout') {
                Write-LauncherEvent @{ type = 'fatal'; ok = $false; code = 'ISOLATED_WORKER_TIMEOUT'; message = 'The isolated conversion worker produced no activity for five minutes and was stopped.' }
            }
        }
        else { $exitCode = $session.ExitCode }
        if ($null -eq $stopReason) { Forward-WorkerLines -Final }
        else { Forward-WorkerLines }
        if ($exitCode -ne 0 -and $exitCode -ne 130 -and -not $script:forwardedResult) {
            Write-LauncherEvent @{ type = 'fatal'; ok = $false; code = 'ISOLATED_WORKER_EXIT_FAILED'; message = "Isolated worker exited without a result (exit code $exitCode)." }
        }
    }
}
catch {
    Write-LauncherEvent @{ type = 'fatal'; ok = $false; code = 'ISOLATION_FAILED'; message = $_.Exception.Message; details = $_.Exception.ToString(); scriptStackTrace = $_.ScriptStackTrace }
    $exitCode = 1
}
finally {
    if ($null -ne $session) {
        $session.Dispose()
        if (-not $session.CleanupComplete) {
            # Do not authorize a replacement while the old COM server may live.
            $exitCode = 1
            try { Write-LauncherEvent @{type='fatal';ok=$false;code='OWNED_ENGINE_CLEANUP_INCOMPLETE';message='이전 한글 엔진의 종료를 확인하지 못해 재시도를 중단했습니다. 원본은 보존됩니다.'} } catch { }
        }
    }
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $scratchDirectory) {
        # Delete only the exact private directory created by this launcher.
        $resolvedScratch = [IO.Path]::GetFullPath($scratchDirectory)
        $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if ($resolvedScratch.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
            ([IO.Path]::GetFileName($resolvedScratch) -match '^hangul-isolation-[0-9a-f]{32}$')) {
            Remove-Item -LiteralPath $resolvedScratch -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
exit $exitCode
