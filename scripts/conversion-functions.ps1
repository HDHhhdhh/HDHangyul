function Write-ConversionEvent {
    param([hashtable] $Event)
    $Event.timestamp = [DateTime]::UtcNow.ToString('o')
    $script:eventWriter.WriteLine(($Event | ConvertTo-Json -Depth 12 -Compress))
}
$script:conversionFunctionsRoot = $PSScriptRoot
function Assert-NotCancelled {
    if ($script:cancelPath -and [IO.File]::Exists($script:cancelPath)) { throw [System.OperationCanceledException]::new('Conversion cancelled.') }
}
function Get-HancomRegistration {
    $registration = $null
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
        $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot,$view)
        try {
            $prog = $root.OpenSubKey('HWPFrame.HwpObject\CLSID')
            if (-not $prog) { continue }
            try { $classId = [string] $prog.GetValue('') } finally { $prog.Dispose() }
            $classKey = $root.OpenSubKey("CLSID\$classId")
            if (-not $classKey) { continue }
            try {
                $server = $classKey.OpenSubKey('LocalServer32')
                if (-not $server) { continue }
                try { $serverPath = [string] $server.GetValue('') } finally { $server.Dispose() }
                $appId = [string] $classKey.GetValue('AppID')
                if ($appId) {
                    $appKey = $root.OpenSubKey("AppID\$appId")
                    if ($appKey) {
                        try {
                            $valueNames = @($appKey.GetValueNames())
                            if ($valueNames -contains 'RunAs' -or $valueNames -contains 'LocalService' -or $valueNames -contains 'DllSurrogate') { return @{ok=$false;message='한글 COM 실행 계정 설정으로 백그라운드 격리를 확인할 수 없습니다.'} }
                        } finally { $appKey.Dispose() }
                    }
                }
                if ($serverPath) { $registration = @{ok=$true;progId='HWPFrame.HwpObject';server=$serverPath;registryView=$view.ToString()} }
            } finally { $classKey.Dispose() }
        } finally { $root.Dispose() }
    }
    if ($registration) { return $registration }
    return @{ok=$false;message='한컴오피스 한글 자동화 엔진이 설치되어 있지 않습니다.'}
}
function Register-HancomSecurityModule {
    param($Hwp)
    $names = @()
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
        $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
        try {
            $key = $root.OpenSubKey('SOFTWARE\HNC\HwpAutomation\Modules')
            if ($key) {
                try { foreach ($name in $key.GetValueNames()) { if ($name -and [IO.File]::Exists([string] $key.GetValue($name))) { $names += $name } } }
                finally { $key.Dispose() }
            }
        } finally { $root.Dispose() }
    }
    # Preserve and try any working user registration before creating the
    # converter-owned fallback.
    foreach ($name in @($names | Select-Object -Unique)) {
        try { if ([bool] $Hwp.RegisterModule('FilePathCheckDLL',$name)) { return $name } } catch { }
    }
    $bundledName = 'HangulConverterFilePathChecker'
    $bundledModule = Join-Path $script:conversionFunctionsRoot 'FilePathCheckerModuleExample.dll'
    $expectedModuleHash = '9AC5B97C47AC8AED1E8BCA27A3EEF39411361D8F68C262509F0C40A8F9D21BB6'
    if ([IO.File]::Exists($bundledModule)) {
        $actualModuleHash = (Get-FileHash -LiteralPath $bundledModule -Algorithm SHA256).Hash
        if ($actualModuleHash -ne $expectedModuleHash) { throw '동봉된 한글 보안 모듈의 무결성 검증에 실패했습니다.' }
        # Hwp.exe is 32-bit on this installation. A converter-owned value keeps
        # registrations belonging to other applications unchanged.
        try {
            $moduleRoot = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry32)
            try {
                $moduleKey = $moduleRoot.CreateSubKey('SOFTWARE\HNC\HwpAutomation\Modules')
                try { $moduleKey.SetValue($bundledName,$bundledModule,[Microsoft.Win32.RegistryValueKind]::String) }
                finally { $moduleKey.Dispose() }
            }
            finally { $moduleRoot.Dispose() }
        }
        catch { throw '한글 보안 모듈의 사용자 등록값을 설정하지 못했습니다.' }
        try { if ([bool] $Hwp.RegisterModule('FilePathCheckDLL',$bundledName)) { return $bundledName } } catch { }
    }
    # Hancom Office can expose its standard checker by registered module name
    # even when the per-user Modules key is temporarily absent. These are the
    # names used by the original converter and Hancom's automation sample.
    foreach ($name in @('FilePathCheckerModuleExample','FilePathCheckerModule')) {
        try { if ([bool] $Hwp.RegisterModule('FilePathCheckDLL',$name)) { return $name } } catch { }
    }
    throw '한글 파일 접근 보안 모듈을 등록하지 못했습니다. 승인창으로 변환이 멈추지 않도록 작업을 중단했습니다.'
}
function Open-HwpDocument {
    param($Hwp,[string] $InputPath)
    $extension = [IO.Path]::GetExtension($InputPath).ToLowerInvariant()
    $formats = switch ($extension) { '.hwp' { @('','HWP') } '.hml' { @('','HWPML2X','HML') } '.hwpx' { @('','HWPX') } }
    foreach ($format in $formats) {
        Assert-NotCancelled
        try { if ([bool] $Hwp.Open($InputPath,$format,'lock:false;forceopen:true;versionwarning:false;')) { return } } catch { }
    }
    throw "한글 문서를 열지 못했습니다: $InputPath"
}
function Assert-OutputFile {
    param([string] $Path,[string] $Kind)
    $info = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($info.Length -lt 16) { throw 'The output file is empty or incomplete.' }
    if ($Kind -eq 'pdf') {
        $stream = [IO.File]::OpenRead($Path)
        try {
            $head = New-Object byte[] 5
            if ($stream.Read($head,0,5) -ne 5 -or [Text.Encoding]::ASCII.GetString($head) -ne '%PDF-') { throw 'Invalid PDF header.' }
            $tailLength = [int] [Math]::Min(4096,$stream.Length)
            $stream.Seek(-$tailLength,[IO.SeekOrigin]::End) | Out-Null
            $tail = New-Object byte[] $tailLength
            $stream.Read($tail,0,$tailLength) | Out-Null
            $text = [Text.Encoding]::ASCII.GetString($tail)
            if ($text -notmatch 'startxref\s+\d+\s+%%EOF\s*$') { throw 'PDF trailer is incomplete.' }
        } finally { $stream.Dispose() }
    }
    elseif ($Kind -eq 'hwpx') {
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($Path)
        try {
            $mime = $zip.GetEntry('mimetype')
            if (-not $mime -or -not $zip.GetEntry('Contents/content.hpf') -or -not $zip.GetEntry('Contents/section0.xml')) { throw 'HWPX package contents are missing.' }
            $reader = New-Object IO.StreamReader($mime.Open())
            try { if ($reader.ReadToEnd().Trim() -ne 'application/hwp+zip') { throw 'Invalid HWPX media type.' } } finally { $reader.Dispose() }
            foreach ($entry in $zip.Entries) {
                if ($entry.FullName -notmatch '\.(xml|hpf)$') { continue }
                $settings = New-Object Xml.XmlReaderSettings
                $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
                $settings.XmlResolver = $null
                $settings.MaxCharactersInDocument = 134217728
                $entryStream = $entry.Open()
                try {
                    $xmlReader = [Xml.XmlReader]::Create($entryStream,$settings)
                    try { while ($xmlReader.Read()) { } } finally { $xmlReader.Dispose() }
                } finally { $entryStream.Dispose() }
            }
        } finally { $zip.Dispose() }
    }
    else { throw 'Unknown output format.' }
}
function New-OutputStage {
    param([string] $OutputPath,[string] $Kind)
    Assert-NotCancelled
    if ([IO.File]::Exists($OutputPath)) { throw 'The reserved output path is now occupied; existing file was preserved.' }
    $directory = [IO.Path]::GetDirectoryName($OutputPath)
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporary = Join-Path $directory ('.hangul-' + [Guid]::NewGuid().ToString('N') + '.partial.' + $Kind)
    [pscustomobject]@{OutputPath=$OutputPath;TemporaryPath=$temporary;Kind=$Kind}
}
function Save-OutputStage {
    param($Hwp,$Stage)
    Assert-NotCancelled
    $saveTimer = [Diagnostics.Stopwatch]::StartNew()
    $saved = [bool] $Hwp.SaveAs($Stage.TemporaryPath,$Stage.Kind.ToUpperInvariant(),'')
    $saveTimer.Stop()
    if ($script:eventWriter) {
        Write-ConversionEvent @{type='log';ok=$saved;code='OUTPUT_SAVE_TIMING';stage='save-output';durationMs=$saveTimer.ElapsedMilliseconds;metrics=@{kind=$Stage.Kind;created=[IO.File]::Exists($Stage.TemporaryPath)}}
    }
    if (-not $saved) { throw '한글이 출력 파일 저장에 실패했습니다.' }
    # Some driver failures return success before a file appears. This check only
    # confirms creation; validation and publication happen after Hwp.Clear() so
    # Hancom no longer owns the HWPX package handle.
    $creationTimer = [Diagnostics.Stopwatch]::StartNew()
    while (-not [IO.File]::Exists($Stage.TemporaryPath) -and $creationTimer.ElapsedMilliseconds -lt 2000) {
        Assert-NotCancelled
        Start-Sleep -Milliseconds 50
    }
    if (-not [IO.File]::Exists($Stage.TemporaryPath)) {
        throw [IO.FileNotFoundException]::new('한글이 저장 성공을 보고했지만 출력 파일을 만들지 못했습니다.', $Stage.TemporaryPath)
    }
}
function Wait-OutputStageReady {
    param($Stage,[int] $TimeoutMs = 5000)
    $readyTimer = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        Assert-NotCancelled
        if (-not [IO.File]::Exists($Stage.TemporaryPath)) {
            throw [IO.FileNotFoundException]::new('저장된 임시 출력 파일을 찾지 못했습니다.', $Stage.TemporaryPath)
        }
        $probe = $null
        try {
            # FileShare.None also detects a handle that permits reading but still
            # blocks rename/delete, which is how Hancom holds freshly saved HWPX.
            $probe = [IO.File]::Open($Stage.TemporaryPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
            return
        }
        catch [IO.IOException] {
            if ($readyTimer.ElapsedMilliseconds -ge $TimeoutMs) {
                throw [IO.IOException]::new('한글이 출력 파일 사용을 끝내지 않아 결과를 확정하지 못했습니다.', $_.Exception)
            }
        }
        catch [UnauthorizedAccessException] {
            if ($readyTimer.ElapsedMilliseconds -ge $TimeoutMs) {
                throw [IO.IOException]::new('출력 파일 접근이 해제되지 않아 결과를 확정하지 못했습니다.', $_.Exception)
            }
        }
        finally { if ($probe) { $probe.Dispose() } }
        Start-Sleep -Milliseconds 50
    }
}
function Publish-OutputStage {
    param($Stage,[int] $ReadyTimeoutMs = 5000)
    Wait-OutputStageReady $Stage $ReadyTimeoutMs
    $validationTimer = [Diagnostics.Stopwatch]::StartNew()
    Assert-OutputFile $Stage.TemporaryPath $Stage.Kind
    Assert-NotCancelled
    if ([IO.File]::Exists($Stage.OutputPath)) { throw 'The reserved output path is now occupied; existing file was preserved.' }
    [IO.File]::Move($Stage.TemporaryPath,$Stage.OutputPath)
    if ($script:eventWriter) {
        Write-ConversionEvent @{type='log';ok=$true;code='OUTPUT_VALIDATION_TIMING';stage='verify-output';durationMs=$validationTimer.ElapsedMilliseconds;metrics=@{kind=$Stage.Kind}}
    }
}
function Remove-TemporaryOutput {
    param([string] $Path,[int] $TimeoutMs = 1000)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $true }
    $cleanupTimer = [Diagnostics.Stopwatch]::StartNew()
    while ([IO.File]::Exists($Path)) {
        try { [IO.File]::Delete($Path) }
        catch [IO.IOException] { }
        catch [UnauthorizedAccessException] { }
        if (-not [IO.File]::Exists($Path)) { return $true }
        if ($cleanupTimer.ElapsedMilliseconds -ge $TimeoutMs) { return $false }
        Start-Sleep -Milliseconds 50
    }
    return $true
}
function Save-ValidatedOutput {
    param($Hwp,[string] $OutputPath,[string] $Kind)
    $stage = New-OutputStage $OutputPath $Kind
    try {
        Save-OutputStage $Hwp $stage
        Publish-OutputStage $stage
    }
    finally { Remove-TemporaryOutput $stage.TemporaryPath | Out-Null }
}
