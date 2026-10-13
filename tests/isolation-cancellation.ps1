[CmdletBinding()]
param()

# Exercise the real wrapper's cancellation function, marker wiring, watchdog
# decision, and stop dispatch. Only the native session and waiting are mocked.
$ErrorActionPreference = 'Stop'
$wrapperPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\isolated-worker.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($wrapperPath, [ref] $tokens, [ref] $errors)
if ($errors.Count) { throw ($errors | Out-String) }
$stopFunction = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Request-WorkerStop' }, $true)
if (-not $stopFunction) { throw 'Request-WorkerStop is missing from the wrapper.' }
. ([scriptblock]::Create($stopFunction.Extent.Text))

$mainTry = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.TryStatementAst] -and @($_.Body.Statements | Where-Object {
        $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$cancelPath'
    }).Count -eq 1
})
if ($mainTry.Count -ne 1) { throw 'Cannot identify the wrapper marker-wiring block.' }
$statements = @($mainTry[0].Body.Statements)
$start = -1
$end = -1
for ($index = 0; $index -lt $statements.Count; $index++) {
    if ($statements[$index] -is [Management.Automation.Language.AssignmentStatementAst] -and $statements[$index].Left.Extent.Text -eq '$cancelPath') { $start = $index }
    if ($start -ge 0 -and $statements[$index].Extent.Text -match '\$job\.options\s*\|\s*Add-Member\s+-NotePropertyName\s+cancelPath\b') { $end = $index; break }
}
if ($start -lt 0 -or $end -lt $start) { throw 'Cannot identify actual child cancellation-path assignment.' }
$script:markerWiringBlock = [scriptblock]::Create(($statements[$start..$end] | ForEach-Object { $_.Extent.Text }) -join "`n")

$watchLoop = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.WhileStatementAst] -and
    $node.Condition.Extent.Text -match 'session\.HasExited' -and
    $node.Body.Extent.Text -match 'HasOwnedProcessCpuActivity'
}, $true))
if ($watchLoop.Count -ne 1) { throw 'Cannot identify actual watchdog loop.' }
$script:watchBlock = [scriptblock]::Create($watchLoop[0].Extent.Text)
$stopDispatch = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Request-WorkerStop'
}, $true))
if ($stopDispatch.Count -ne 1) { throw 'Expected one worker-stop dispatch in the wrapper.' }
$script:stopDispatchBlock = [scriptblock]::Create($stopDispatch[0].Extent.Text)

function Get-MarkerWiring([string] $SharedPath, [string] $ScratchRoot) {
    $scratchDirectory = $ScratchRoot
    $job = [pscustomobject] @{ options = [pscustomobject] @{ cancelPath = $SharedPath } }
    . $script:markerWiringBlock
    return [pscustomobject] @{ shared = $cancelPath; private = $privateCancelPath; child = $job.options.cancelPath }
}

function Get-StopReason([string] $SharedPath, [long] $InactiveMilliseconds) {
    $cancelPath = $SharedPath
    $stopReason = $null
    $session = [pscustomobject] @{ HasExited = $false }
    $session | Add-Member -MemberType ScriptMethod -Name HasOwnedProcessCpuActivity -Value { return $false }
    $script:lastActivity = [pscustomobject] @{ ElapsedMilliseconds = $InactiveMilliseconds }
    function Forward-WorkerLines { }
    function Start-Sleep { throw 'Expected cancellation/timeout decision was not reached before sleeping.' }
    . $script:watchBlock
    return $stopReason
}

function Invoke-ActualStopDispatch([string] $Reason, [string] $SharedPath, [string] $PrivatePath) {
    $stopReason = $Reason
    $cancelPath = $SharedPath
    $privateCancelPath = $PrivatePath
    . $script:stopDispatchBlock
}

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('hangul-cancel-test-' + [Guid]::NewGuid().ToString('N'))
$checked = @()
try {
    $workerA = Join-Path $scratch 'worker-a'
    $workerB = Join-Path $scratch 'worker-b'
    [IO.Directory]::CreateDirectory($workerA) | Out-Null
    [IO.Directory]::CreateDirectory($workerB) | Out-Null
    $shared = Join-Path $scratch 'batch-cancel.requested'
    $a = Get-MarkerWiring $shared $workerA
    $b = Get-MarkerWiring $shared $workerB
    Assert-True ($a.shared -eq $shared -and $b.shared -eq $shared) 'Shared user-cancellation path was lost.'
    Assert-True ($a.child -eq $a.private -and $b.child -eq $b.private -and $a.private -ne $b.private -and $a.private -ne $shared) 'Children must receive distinct private markers instead of the caller-supplied shared marker.'
    $checked += 'child marker override and independent paths'

    $reason = Get-StopReason $shared 300000
    Assert-True ($reason -eq 'timeout') 'Idle worker did not select timeout.'
    Invoke-ActualStopDispatch $reason $shared $a.private
    Assert-True ([IO.File]::ReadAllText($a.private) -eq 'timeout') 'Timeout was not sent to the affected child.'
    Assert-True (-not [IO.File]::Exists($shared) -and -not [IO.File]::Exists($b.private)) 'A worker timeout touched the shared marker or another child.'
    $checked += 'timeout affects only its own child'

    [IO.File]::WriteAllText($shared, 'user-owned-cancel-token')
    foreach ($worker in @($a, $b)) {
        $reason = Get-StopReason $shared 0
        Assert-True ($reason -eq 'cancel') 'Shared user cancellation was not observed.'
        Invoke-ActualStopDispatch $reason $shared $worker.private
        Assert-True ([IO.File]::ReadAllText($worker.private) -eq 'cancel') 'User cancellation was not forwarded to a child.'
    }
    Assert-True ([IO.File]::ReadAllText($shared) -eq 'user-owned-cancel-token') 'Wrapper overwrote the caller-owned shared marker.'
    $checked += 'shared user cancellation forwards without modification'

    $literalShared = Join-Path $scratch 'batch-$(throw injected); quote''; & noop.requested'
    [IO.File]::WriteAllText($literalShared, 'literal-user-token')
    $literal = Get-MarkerWiring $literalShared $workerB
    $reason = Get-StopReason $literalShared 0
    Assert-True ($reason -eq 'cancel' -and $literal.shared -ceq $literalShared) 'Cancellation path metacharacters were not treated literally.'
    Invoke-ActualStopDispatch $reason $literalShared $literal.private
    Assert-True ([IO.File]::ReadAllText($literalShared) -eq 'literal-user-token') 'Injected-looking shared path was used as a write target.'
    $literalPrivate = Join-Path $workerA 'child-$(throw injected); quote''; & noop.requested'
    Request-WorkerStop 'timeout; $(throw injected)' $literalPrivate
    Assert-True ([IO.File]::ReadAllText($literalPrivate) -ceq 'timeout; $(throw injected)') 'Private marker path or reason was evaluated as code.'
    $checked += 'path metacharacters remain literal and shared paths stay read-only'

    $relativeRejected = $false
    try { Get-MarkerWiring '..\outside.requested' $workerA | Out-Null }
    catch { if ($_.Exception.Message -notmatch 'absolute path') { throw }; $relativeRejected = $true }
    Assert-True $relativeRejected 'A relative caller-supplied cancellation path was accepted.'
    $checked += 'relative shared marker rejected'
}
finally {
    $resolved = [IO.Path]::GetFullPath($scratch)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^hangul-cancel-test-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}
[pscustomobject] @{ ok=$true; checked=$checked; nativeRuntimeTested=$false } | ConvertTo-Json -Compress
