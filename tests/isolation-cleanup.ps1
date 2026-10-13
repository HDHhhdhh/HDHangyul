[CmdletBinding()]
param()

# Extract production cleanup methods and substitute only native/time boundaries.
# This test never opens, observes, launches, or terminates a native process.
$ErrorActionPreference = 'Stop'
$helper = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/DesktopIsolation.cs'
$source = [IO.File]::ReadAllText($helper)
function Get-CSharpBlock([string] $Text, [string] $Signature) {
    $start = $Text.IndexOf($Signature, [StringComparison]::Ordinal)
    if ($start -lt 0) { throw "Missing source block: $Signature" }
    $position = $Text.IndexOf('{', $start)
    $depth = 1
    while ($depth -gt 0 -and ++$position -lt $Text.Length) {
        if ($Text[$position] -eq '{') { $depth++ }
        elseif ($Text[$position] -eq '}') { $depth-- }
    }
    if ($depth -ne 0) { throw "Unbalanced source block: $Signature" }
    return $Text.Substring($start, $position - $start + 1)
}
$methods = @('public void Terminate()', 'public void Dispose()', 'private static bool WaitForCleanupExit(', 'private static bool CloseCleanupHandle(') | ForEach-Object { Get-CSharpBlock $source $_ }
$harness = @'
using System;
using System.Collections.Generic;
namespace HangulCleanupTests {
    public sealed class Stopwatch {
        public static long Now;
        private long started;
        public static Stopwatch StartNew() { return new Stopwatch { started = Now }; }
        public long ElapsedMilliseconds { get { return Now - started; } }
    }
    public sealed class Session {
        private readonly Dictionary<int,IntPtr> ownedProcesses = new Dictionary<int,IntPtr>();
        private readonly Dictionary<int,ulong> ownedCpuSamples = new Dictionary<int,ulong>();
        private bool disposed;
        private IntPtr Desktop, Job, Process;
        public bool CleanupComplete { get; private set; }
        public bool HandlesReleased { get { return ownedProcesses.Count == 0 && ownedCpuSamples.Count == 0 && Desktop == IntPtr.Zero && Job == IntPtr.Zero && Process == IntPtr.Zero; } }
        public void Seed() {
            ownedProcesses.Add(11,new IntPtr(11)); ownedProcesses.Add(12,new IntPtr(12));
            ownedCpuSamples.Add(11,123); ownedCpuSamples.Add(12,456);
            Process=new IntPtr(21); Job=new IntPtr(31); Desktop=new IntPtr(41);
        }
        __METHODS__
    }
    public static class Native {
        public static readonly Dictionary<int,uint> Delays = new Dictionary<int,uint>();
        public static readonly List<uint> WaitBudgets = new List<uint>();
        public static readonly List<int> Closed = new List<int>();
        public static int FailedWait, ThrowWait, FailedClose, ThrowClose;
        public static bool ThrowTerminate;
        public static void Reset() {
            Delays.Clear(); WaitBudgets.Clear(); Closed.Clear(); Stopwatch.Now=0;
            FailedWait=ThrowWait=FailedClose=ThrowClose=0; ThrowTerminate=false;
        }
        public static uint WaitForSingleObject(IntPtr handle,uint milliseconds) {
            WaitBudgets.Add(milliseconds);
            int id=handle.ToInt32();
            if (id==ThrowWait) throw new InvalidOperationException("Unknown wait failure");
            if (id==FailedWait) return UInt32.MaxValue;
            uint delay; if (!Delays.TryGetValue(id,out delay)) return 0;
            uint elapsed=Math.Min(delay,milliseconds); Stopwatch.Now+=elapsed; Delays[id]=delay-elapsed;
            return delay<=milliseconds ? 0u : 258u;
        }
        public static bool TerminateProcess(IntPtr handle,uint exitCode) { return true; }
        public static bool TerminateJobObject(IntPtr handle,uint exitCode) {
            if (ThrowTerminate) throw new InvalidOperationException("Unknown termination failure");
            return true;
        }
        public static bool CloseHandle(IntPtr handle) {
            int id=handle.ToInt32(); Closed.Add(id);
            if (id==ThrowClose) throw new InvalidOperationException("Unknown close failure");
            return id!=FailedClose;
        }
        public static bool CloseDesktop(IntPtr handle) { return CloseHandle(handle); }
    }
}
'@
Add-Type -TypeDefinition $harness.Replace('__METHODS__', ($methods -join "`n"))
function New-Case {
    [HangulCleanupTests.Native]::Reset()
    $instance = New-Object HangulCleanupTests.Session
    $instance.Seed()
    if ($instance.CleanupComplete) { throw 'Cleanup was confirmed before disposal.' }
    return $instance
}
function Assert-HandlesReleased($Instance) {
    if (-not $Instance.HandlesReleased -or ([HangulCleanupTests.Native]::Closed.ToArray() -join ',') -ne '11,12,21,31,41') { throw 'A cleanup path did not release every owned handle.' }
}

$session = New-Case
[HangulCleanupTests.Native]::Delays.Add(11,400)
[HangulCleanupTests.Native]::Delays.Add(12,600)
[HangulCleanupTests.Native]::Delays.Add(21,200)
$session.Dispose()
Assert-HandlesReleased $session
if (-not $session.CleanupComplete -or [HangulCleanupTests.Stopwatch]::Now -ne 1200) { throw 'Cleanup did not await all owned process exits.' }
$budgets = [HangulCleanupTests.Native]::WaitBudgets.ToArray() | Select-Object -Last 3
if (($budgets -join ',') -ne '5000,4600,4000') { throw 'Process waits do not share their deadline.' }

$session = New-Case
foreach ($id in @(11,12,21)) { [HangulCleanupTests.Native]::Delays.Add($id,4000) }
$session.Dispose()
Assert-HandlesReleased $session
if ($session.CleanupComplete -or [HangulCleanupTests.Stopwatch]::Now -ne 5000) { throw 'Aggregate cleanup timeout exceeded its budget or reported success.' }
$waitCount = [HangulCleanupTests.Native]::WaitBudgets.Count
$session.Dispose()
if ($session.CleanupComplete -or [HangulCleanupTests.Native]::WaitBudgets.Count -ne $waitCount -or [HangulCleanupTests.Native]::Closed.Count -ne 5) { throw 'Repeated disposal changed an unconfirmed cleanup result.' }

foreach ($failure in @('FailedWait','ThrowWait','FailedClose','ThrowClose','ThrowTerminate')) {
    $session = New-Case
    $value = if ($failure -eq 'ThrowTerminate') { $true } else { 11 }
    [HangulCleanupTests.Native].GetField($failure).SetValue($null,$value)
    $session.Dispose()
    Assert-HandlesReleased $session
    if ($session.CleanupComplete) { throw "Unknown native failure reported confirmed cleanup: $failure" }
}
[HangulCleanupTests.Native]::Reset()
$empty = New-Object HangulCleanupTests.Session
$empty.Dispose()
if (-not $empty.CleanupComplete -or -not $empty.HandlesReleased -or [HangulCleanupTests.Native]::WaitBudgets.Count -ne 0) { throw 'Empty session cleanup was not handled.' }
[pscustomobject]@{ok=$true; cases=8; nativeRuntimeTested=$false; checked=@('Actual production methods','All owned handles','Aggregate five-second deadline','Unknown failures','Finally cleanup','Idempotency')} | ConvertTo-Json -Compress
