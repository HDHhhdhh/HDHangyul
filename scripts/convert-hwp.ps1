[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $InputJsonPath,
    [switch] $IsolatedWorker,
    [string] $ExpectedDesktop,
    [string] $EventPath
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
if (-not $IsolatedWorker) {
    try { [Console]::OutputEncoding = $OutputEncoding } catch { }
}
# The interactive process never creates HWP COM objects. There is no fallback.
if (-not $IsolatedWorker) {
    & (Join-Path $PSScriptRoot 'isolated-worker.ps1') -InputJsonPath $InputJsonPath -WorkerScriptPath $PSCommandPath
    exit $LASTEXITCODE
}
$script:eventWriter = $null
$hwp = $null
$isolationVerified = $false
$pendingTemporaryPaths = New-Object 'System.Collections.Generic.List[string]'
$stage = 'bootstrap'
try {
    if ([string]::IsNullOrWhiteSpace($EventPath) -or [string]::IsNullOrWhiteSpace($ExpectedDesktop)) { throw 'An isolated desktop and event channel are required.' }
    $script:eventWriter = New-Object System.IO.StreamWriter($EventPath, $true, (New-Object System.Text.UTF8Encoding $false))
    $script:eventWriter.AutoFlush = $true
    $script:eventWriter.WriteLine((@{type='log';ok=$true;code='WORKER_BOOTSTRAP';message='Isolated worker script started.'} | ConvertTo-Json -Compress))
    $stage = 'load-isolation-helper'
    . (Join-Path $PSScriptRoot 'conversion-functions.ps1')
    Add-Type -Path (Join-Path $PSScriptRoot 'DesktopIsolation.cs')
    [HanGulConverter.DesktopIsolation]::AssertCurrentDesktop($ExpectedDesktop)
    Write-ConversionEvent @{type='log';ok=$true;code='WORKER_DESKTOP_CONFIRMED';message='Worker desktop isolation confirmed.'}
    $job = Get-Content -LiteralPath $InputJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $script:cancelPath = [string] $job.options.cancelPath
    Assert-NotCancelled
    $registration = Get-HancomRegistration
    if (-not $registration.ok) { throw $registration.message }
    $stage = 'create-hancom-com'
    Write-ConversionEvent @{type='log';ok=$true;code='HANCOM_COM_STARTING';message='Starting the Hancom automation engine.'}
    $hwp = New-Object -ComObject 'HWPFrame.HwpObject'
    $hwpWindow = $hwp.XHwpWindows.Item(0)
    $stage = 'verify-hancom-isolation'
    $windowHandle = [long] $hwpWindow.WindowHandle
    $hwpProcessId = [HanGulConverter.DesktopIsolation]::AssertWindowDesktop($windowHandle, $ExpectedDesktop)
    $isolationVerified = $true
    Write-ConversionEvent @{type='isolated-process';ok=$true;processId=$hwpProcessId;windowHandle=$windowHandle;expectedDesktop=$ExpectedDesktop}
    $ackPath = [string] $job.options.isolationAckPath
    if (-not [IO.Path]::IsPathRooted($ackPath)) { throw 'An isolation ownership acknowledgement is required.' }
    $ackTimer = [Diagnostics.Stopwatch]::StartNew()
    while (-not [IO.File]::Exists($ackPath)) {
        Assert-NotCancelled
        if ($ackTimer.ElapsedMilliseconds -gt 15000) { throw 'Timed out waiting for isolation ownership acknowledgement.' }
        Start-Sleep -Milliseconds 50
    }
    if ([IO.File]::ReadAllText($ackPath) -ne $ExpectedDesktop) { throw 'The isolation ownership acknowledgement does not match.' }
    $hwpWindow.Visible = $false
    $stage = 'register-file-access-module'
    $moduleName = Register-HancomSecurityModule $hwp
    Write-ConversionEvent @{type='log';ok=$true;level='info';message="격리된 한글 엔진을 재사용합니다. 보안 모듈: $moduleName"}
    $tasks = @($job.tasks)
    $summary = @{total=$tasks.Count;succeeded=0;failed=0;pdf=0;hwpx=0}
    for ($index = 0; $index -lt $tasks.Count; $index++) {
        $stage = 'convert-document'
        Assert-NotCancelled
        $task = $tasks[$index]
        $inputPath = [string] $task.inputPath
        $outputs = @()
        $errors = @()
        $targets = @()
        $stagedOutputs = @()
        $temporaryOutputs = @()
        $closed = $false
        $cancelled = $false
        $engineRecycle = $false
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        Write-ConversionEvent @{type='file-start';ok=$true;taskId=$task.id;inputPath=$inputPath;inputName=$task.inputName;index=($index+1);total=$tasks.Count}
        try {
            $extension = [IO.Path]::GetExtension($inputPath).ToLowerInvariant()
            if (@('.hwp','.hml','.hwpx') -notcontains $extension) { throw 'Unsupported input extension.' }
            if (-not [IO.File]::Exists($inputPath)) { throw 'The input file no longer exists.' }
            $targets = @($task.targets | Select-Object -Unique)
            if ($targets.Count -eq 0) { throw 'No output targets were requested.' }
            foreach ($target in $targets) {
                if (@('pdf','hwpx') -notcontains $target -or ($target -eq 'hwpx' -and $extension -eq '.hwpx')) { throw 'Unsupported conversion target.' }
                $planned = [string] $task.plannedOutputPaths.$target
                if (-not [IO.Path]::IsPathRooted($planned) -or [string]::Equals($planned,$inputPath,[StringComparison]::OrdinalIgnoreCase)) { throw 'A distinct absolute planned output path is required.' }
            }
            Assert-NotCancelled
            Open-HwpDocument $hwp $inputPath
            Write-ConversionEvent @{type='file-opened';ok=$true;taskId=$task.id;inputPath=$inputPath}
            foreach ($target in @('pdf','hwpx')) {
                if ($targets -notcontains $target) { continue }
                Assert-NotCancelled
                $outputPath = [string] $task.plannedOutputPaths.$target
                try {
                    $outputStage = New-OutputStage $outputPath $target
                    $temporaryOutputs += $outputStage
                    $pendingTemporaryPaths.Add($outputStage.TemporaryPath)
                    Save-OutputStage $hwp $outputStage
                    $stagedOutputs += $outputStage
                }
                catch [System.OperationCanceledException] { throw }
                catch [System.IO.FileNotFoundException] {
                    if ($target -eq 'pdf' -and $outputs.Count -eq 0) {
                        $engineRecycle = $true
                        $errors += @{kind=$target;message=$_.Exception.Message}
                        break
                    }
                    $errors += @{kind=$target;message=$_.Exception.Message}
                    Write-ConversionEvent @{type='output-error';ok=$false;taskId=$task.id;outputKind=$target;outputPath=$outputPath;code='OUTPUT_SAVE_FAILED';message=$_.Exception.Message}
                }
                catch {
                    $errors += @{kind=$target;message=$_.Exception.Message}
                    Write-ConversionEvent @{type='output-error';ok=$false;taskId=$task.id;outputKind=$target;outputPath=$outputPath;code='OUTPUT_SAVE_FAILED';message=$_.Exception.Message}
                }
            }
        }
        catch [System.OperationCanceledException] {
            $cancelled = $true
            $errors += @{message='변환을 취소했습니다. 원본을 보존합니다.'}
        }
        catch { $errors += @{message=$_.Exception.Message} }
        finally {
            try { $hwp.Clear(1) | Out-Null; $closed = $true }
            catch { $errors += @{message='문서를 닫지 못했습니다. 원본을 보존합니다.'} }
        }
        # Hancom can retain a freshly written HWPX handle until the source
        # document is closed. Validate and rename only after Clear() succeeds.
        if ($closed -and -not $cancelled -and -not $engineRecycle) {
            foreach ($outputStage in $stagedOutputs) {
                try {
                    Publish-OutputStage $outputStage
                    $outputs += @{kind=$outputStage.Kind;path=$outputStage.OutputPath}
                    $summary[$outputStage.Kind] += 1
                    Write-ConversionEvent @{type='output-complete';ok=$true;taskId=$task.id;inputPath=$inputPath;outputPath=$outputStage.OutputPath;outputKind=$outputStage.Kind}
                }
                catch [System.OperationCanceledException] {
                    $cancelled = $true
                    $errors += @{message='변환을 취소했습니다. 원본을 보존합니다.'}
                    break
                }
                catch {
                    $errors += @{kind=$outputStage.Kind;message=$_.Exception.Message}
                    Write-ConversionEvent @{type='output-error';ok=$false;taskId=$task.id;outputKind=$outputStage.Kind;outputPath=$outputStage.OutputPath;code='OUTPUT_PUBLISH_FAILED';message=$_.Exception.Message}
                }
            }
        }
        foreach ($outputStage in $temporaryOutputs) {
            if (Remove-TemporaryOutput $outputStage.TemporaryPath 5000) {
                $pendingTemporaryPaths.Remove($outputStage.TemporaryPath) | Out-Null
            }
            else {
                $message = '한글이 임시 출력 파일 사용을 끝내지 않아 정리하지 못했습니다.'
                $errors += @{kind=$outputStage.Kind;message=$message}
                Write-ConversionEvent @{type='output-error';ok=$false;taskId=$task.id;outputKind=$outputStage.Kind;outputPath=$outputStage.OutputPath;code='OUTPUT_CLEANUP_PENDING';message=$message}
            }
        }
        $timer.Stop()
        if ($engineRecycle -and $closed -and -not $cancelled) {
            Assert-NotCancelled
            Write-ConversionEvent @{type='worker-recycle';ok=$false;taskId=$task.id;inputPath=$inputPath;code='PDF_OUTPUT_MISSING';message=($errors.message -join ' ');durationMs=$timer.ElapsedMilliseconds}
            # Parent replaces this entire isolated worker after process exit,
            # preserving fresh desktop/COM ownership and acknowledgement checks.
            exit 75
        }
        if ($closed -and -not $cancelled -and $errors.Count -eq 0 -and $outputs.Count -eq $targets.Count) {
            Assert-NotCancelled
            $summary.succeeded += 1
            Write-ConversionEvent @{type='file-complete';ok=$true;taskId=$task.id;inputPath=$inputPath;outputs=$outputs;durationMs=$timer.ElapsedMilliseconds}
        }
        else {
            $summary.failed += 1
            Write-ConversionEvent @{type='file-error';ok=$false;taskId=$task.id;inputPath=$inputPath;outputs=$outputs;errors=$errors;code='FILE_CONVERSION_FAILED';message=($errors.message -join ' ');durationMs=$timer.ElapsedMilliseconds}
        }
        if (-not $closed) { throw 'The HWP engine could not close its document; the batch was stopped.' }
        if ($cancelled) { throw [System.OperationCanceledException]::new('Conversion cancelled.') }
    }
    Write-ConversionEvent @{type='complete';ok=($summary.failed -eq 0);summary=$summary}
}
catch [System.OperationCanceledException] {
    if ($script:eventWriter) { Write-ConversionEvent @{type='cancelled';ok=$false;message='변환을 취소했습니다. 원본을 보존합니다.'} }
    exit 2
}
catch {
    $failure = @{type='fatal';ok=$false;code='ISOLATED_CONVERSION_FAILED';stage=$stage;message=$_.Exception.Message;details=$_.Exception.ToString();scriptStackTrace=$_.ScriptStackTrace}
    if ($script:eventWriter) { $script:eventWriter.WriteLine(($failure | ConvertTo-Json -Depth 10 -Compress)) }
    else { [Console]::Out.WriteLine(($failure | ConvertTo-Json -Compress)) }
    exit 1
}
finally {
    if ($hwp -and $isolationVerified) { try { $hwp.Quit() | Out-Null } catch { } }
    if ($hwp) { try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($hwp) | Out-Null } catch { } }
    foreach ($temporaryPath in @($pendingTemporaryPaths)) { Remove-TemporaryOutput $temporaryPath 2000 | Out-Null }
    if ($script:eventWriter) { $script:eventWriter.Dispose() }
}
