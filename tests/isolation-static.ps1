[CmdletBinding()]
param()

# Intentionally static/pure-managed verification. Does not launch a worker,
# instantiate HWP, inspect native desktop state, or invoke any Win32 import.
$ErrorActionPreference = 'Stop'
$scriptRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts'
$helperPath = Join-Path $scriptRoot 'DesktopIsolation.cs'
$launcherPath = Join-Path $scriptRoot 'isolated-worker.ps1'
$tokens = $null
$errors = $null
[Management.Automation.Language.Parser]::ParseFile($launcherPath, [ref] $tokens, [ref] $errors) | Out-Null
if ($errors.Count -ne 0) { throw ($errors | Out-String) }
if (-not ('HanGulConverter.DesktopIsolation' -as [type])) { Add-Type -Path $helperPath }

$argumentCases = @(
    @{ input = ''; expected = '""' },
    @{ input = 'C:\docs\plain.hwp'; expected = '"C:\docs\plain.hwp"' },
    @{ input = 'C:\자료 폴더\a b.hwp'; expected = '"C:\자료 폴더\a b.hwp"' },
    @{ input = 'C:\trailing\'; expected = '"C:\trailing\\"' },
    @{ input = 'a"b'; expected = '"a\"b"' },
    @{ input = 'a\"b'; expected = '"a\\\"b"' },
    @{ input = '$(unsafe) & literal'; expected = '"$(unsafe) & literal"' }
)
foreach ($case in $argumentCases) {
    $actual = [HanGulConverter.DesktopIsolation]::QuoteArgument($case.input)
    if ($actual -cne $case.expected) { throw "Command argument quoting failed: $($case.input) -> $actual" }
}

$nulRejected = $false
try { [HanGulConverter.DesktopIsolation]::QuoteArgument("a`0b") | Out-Null }
catch { $nulRejected = $true }
if (-not $nulRejected) { throw 'NUL argument was accepted.' }

# These invalid names must be rejected BEFORE native state could be read.
foreach ($invalid in @('', 'Default', 'WinSta0\Default', 'WinSta0\HangulConverter_example', 'Private\HangulConverter_0123456789abcdef0123456789abcdef')) {
    $rejected = $false
    try { [HanGulConverter.DesktopIsolation]::AssertCurrentDesktop($invalid) }
    catch {
        if ($_.Exception.ToString() -notmatch 'explicit private conversion desktop') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "Interactive/unspecified desktop accepted: $invalid" }
}

# Validate the one supported name shape without invoking the native state check.
$parseDesktop = [HanGulConverter.DesktopIsolation].GetMethod('ParseDesktop', [Reflection.BindingFlags] 'NonPublic,Static')
$validDesktop = 'WinSta0\HangulConverter_0123456789abcdef0123456789abcdef'
$parts = $parseDesktop.Invoke($null, @($validDesktop))
if ($parts.Count -ne 2 -or $parts[0] -ne 'WinSta0' -or $parts[1] -ne 'HangulConverter_0123456789abcdef0123456789abcdef') {
    throw 'Private WinSta0 desktop name was not accepted.'
}

$source = [IO.File]::ReadAllText($helperPath)
foreach ($forbidden in @('SwitchDesktop', 'SetProcessWindowStation', 'CreateWindowStation', 'SetForegroundWindow', 'GetForegroundWindow', 'SendInput', 'BlockInput', 'LockSetForegroundWindow')) {
    if ($source -match ('\b' + $forbidden + '\b')) { throw "Prohibited desktop/focus API present: $forbidden" }
}
if (([regex]::Matches($source, 'Native\.SetThreadDesktop\(')).Count -ne 1 -or
    $source -notmatch '(?s)Thread verifier = new Thread\(delegate\(\).*?Native\.SetThreadDesktop\(Desktop\).*?RegisterIsolatedWindowProcessOnDesktop\(processId, windowHandle\)' -or
    $source -notmatch 'verifier\.Join\(\)') {
    throw 'Ownership verification must associate only its fresh thread with the private desktop and await thread cleanup.'
}

[pscustomobject] @{
    ok = $true
    checked = @('PowerShell parse', 'C# compilation', 'Windows argument quoting', 'Pre-native isolation validation', 'No focus-control imports', 'Fresh verifier thread and join')
    nativeRuntimeTested = $false
} | ConvertTo-Json -Compress
