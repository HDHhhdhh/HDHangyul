[CmdletBinding()]
param()

# Unit-test the launcher's event/ack boundary with a mock session. There are no
# native calls, real processes, HWP objects, or native desktop observations.
$ErrorActionPreference = 'Stop'
$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\isolated-worker.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref] $tokens, [ref] $errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Forward-WorkerLines' }, $true)
. ([scriptblock]::Create($function.Extent.Text))
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('hangul-ack-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
$script:isolationAckPath = Join-Path $scratch 'registered.ack'
$script:lastActivity = [Diagnostics.Stopwatch]::StartNew()
$script:session = [pscustomobject] @{ ExpectedDesktop = 'WinSta0\HangulConverter_0123456789abcdef0123456789abcdef'; Registered = $false; Reject = $false }
$script:session | Add-Member -MemberType ScriptMethod -Name RegisterIsolatedWindowProcess -Value {
    param($processId, $windowHandle)
    if ([IO.File]::Exists($script:isolationAckPath)) { throw 'Acknowledgement was published before registration.' }
    if ($this.Reject) { throw 'Mock isolation verification failed.' }
    if ($processId -ne 42 -or $windowHandle -ne 99) { throw 'Wrong process registration arguments.' }
    $this.Registered = $true
}
$eventLine = (@{ type='isolated-process'; processId=42; windowHandle=99; expectedDesktop=$script:session.ExpectedDesktop } | ConvertTo-Json -Compress) + "`n"
$originalOutput = [Console]::Out
$capturedOutput = New-Object IO.StringWriter
try {
    [Console]::SetOut($capturedOutput)
    $script:tailBuffer = ''
    $bytes = [Text.Encoding]::UTF8.GetBytes($eventLine)
    $memory = New-Object IO.MemoryStream(,$bytes)
    $script:reader = New-Object IO.StreamReader($memory)
    Forward-WorkerLines -Final
    $script:reader.Dispose()
    if (-not $script:session.Registered) { throw 'Session registration was skipped.' }
    if ([IO.File]::ReadAllText($script:isolationAckPath) -cne $script:session.ExpectedDesktop) { throw 'Acknowledgement does not identify the expected desktop.' }
    if ([IO.File]::Exists($script:isolationAckPath + '.tmp')) { throw 'Atomic publication left its temporary marker.' }
    [IO.File]::Delete($script:isolationAckPath)

    $script:session.Reject = $true
    $script:session.Registered = $false
    $script:tailBuffer = ''
    $memory = New-Object IO.MemoryStream(,$bytes)
    $script:reader = New-Object IO.StreamReader($memory)
    $rejected = $false
    try { Forward-WorkerLines -Final }
    catch { if ($_.Exception.Message -notmatch 'Mock isolation verification failed') { throw }; $rejected = $true }
    finally { $script:reader.Dispose() }
    if (-not $rejected -or [IO.File]::Exists($script:isolationAckPath)) { throw 'Failed isolation verification published an acknowledgement.' }
}
finally {
    [Console]::SetOut($originalOutput)
    $capturedOutput.Dispose()
    $resolved = [IO.Path]::GetFullPath($scratch)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^hangul-ack-test-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
[pscustomobject] @{ ok=$true; checked=@('ack after registration', 'atomic ack publication', 'no ack after isolation rejection'); nativeRuntimeTested=$false } | ConvertTo-Json -Compress
