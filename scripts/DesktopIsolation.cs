using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace HanGulConverter
{
    // Product worker isolation, not a desktop-control or focus-restoration helper.
    // A fresh process must be born here: COM caches its station/desktop at activation.
    public static class DesktopIsolation
    {
        public static string QuoteArgument(string value)
        {
            if (value == null || value.IndexOf('\0') >= 0)
                throw new ArgumentException("A process argument must be non-null and contain no NUL.");
            StringBuilder quoted = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"') quoted.Append('\\', slashes * 2 + 1);
                else quoted.Append('\\', slashes);
                slashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', slashes * 2).Append('"');
            return quoted.ToString();
        }

        private static string[] ParseDesktop(string expected)
        {
            string[] parts = (expected ?? "").Split('\\');
            if (parts.Length != 2 || !parts[0].Equals("WinSta0", StringComparison.OrdinalIgnoreCase) ||
                !Regex.IsMatch(parts[1], "\\AHangulConverter_[0-9a-f]{32}\\z", RegexOptions.CultureInvariant))
                throw new InvalidOperationException("An explicit private conversion desktop is required; the default desktop is never allowed.");
            return parts;
        }

        private static string ObjectName(IntPtr handle)
        {
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            int needed;
            Native.GetUserObjectInformation(handle, 2, IntPtr.Zero, 0, out needed);
            if (needed <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!Native.GetUserObjectInformation(handle, 2, buffer, needed, out needed))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return Marshal.PtrToStringUni(buffer);
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        public static void AssertCurrentDesktop(string expectedQualifiedDesktop)
        {
            string[] parts = ParseDesktop(expectedQualifiedDesktop);
            IntPtr station = Native.GetProcessWindowStation();
            if (!ObjectName(station).Equals(parts[0], StringComparison.OrdinalIgnoreCase) ||
                !ObjectName(Native.GetThreadDesktop(Native.GetCurrentThreadId())).Equals(parts[1], StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Worker did not start on its expected isolated desktop.");
        }

        // Return only a PID belonging to an HWND on this run's uniquely named desktop.
        // Merely passing a PID or a process name never grants termination ownership.
        public static int AssertWindowDesktop(long windowHandle, string expectedQualifiedDesktop)
        {
            string[] parts = ParseDesktop(expectedQualifiedDesktop);
            IntPtr window = new IntPtr(windowHandle);
            uint processId;
            uint threadId = Native.GetWindowThreadProcessId(window, out processId);
            if (threadId == 0 || processId == 0)
                throw new InvalidOperationException("HWP did not expose a valid automation window.");
            string desktop = ObjectName(Native.GetThreadDesktop(threadId));
            if (!desktop.Equals(parts[1], StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("HWP is outside the isolated conversion desktop. Conversion was stopped.");
            return checked((int)processId);
        }

        public static IsolationSession StartWorker(string executable, string scriptPath, string inputJsonPath, string eventPath)
        {
            foreach (string value in new string[] { executable, scriptPath, inputJsonPath, eventPath })
                if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value))
                    throw new ArgumentException("Worker launch paths must be absolute.");
            if (!File.Exists(executable) || !File.Exists(scriptPath) || !File.Exists(inputJsonPath))
                throw new FileNotFoundException("The worker executable, script, or input JSON is missing.");

            IsolationSession session = new IsolationSession();
            IntPtr securityDescriptor = IntPtr.Zero;
            try
            {
                string sid = WindowsIdentity.GetCurrent().User.Value;
                uint securitySize;
                if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptor(
                    "D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1, out securityDescriptor, out securitySize))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                Native.SECURITY_ATTRIBUTES security = new Native.SECURITY_ATTRIBUTES();
                security.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
                security.lpSecurityDescriptor = securityDescriptor;
                security.bInheritHandle = false;

                // Use the resources of the caller's interactive station, but
                // give each worker a newly created desktop
                // that is never made the input desktop. The station and launcher
                // main-thread desktop stay unchanged; no desktop switch API is used.
                IntPtr callerStation = Native.GetProcessWindowStation();
                string stationName = ObjectName(callerStation);
                if (!stationName.Equals("WinSta0", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Launch conversion from the signed-in user's Windows session.");
                string desktopName = "HangulConverter_" + Guid.NewGuid().ToString("N");
                session.Desktop = Native.CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, 0x000F01FF, ref security);
                if (session.Desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                session.ExpectedDesktop = stationName + "\\" + desktopName;

                session.Job = Native.CreateJobObject(IntPtr.Zero, null);
                if (session.Job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
                if (!Native.SetInformationJobObject(session.Job, 9, ref limits,
                    (uint)Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                    throw new Win32Exception(Marshal.GetLastWin32Error());

                string[] args = { executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA",
                    "-File", scriptPath, "-InputJsonPath", inputJsonPath, "-IsolatedWorker",
                    "-ExpectedDesktop", session.ExpectedDesktop, "-EventPath", eventPath };
                StringBuilder command = new StringBuilder();
                foreach (string arg in args) { if (command.Length > 0) command.Append(' '); command.Append(QuoteArgument(arg)); }
                Native.STARTUPINFO start = new Native.STARTUPINFO();
                start.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
                start.lpDesktop = session.ExpectedDesktop;
                start.dwFlags = 0x00000001 | 0x00000080; // hidden, no feedback cursor
                start.wShowWindow = 0;
                Native.PROCESS_INFORMATION process;
                if (!Native.CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false,
                    0x08000000 | 0x00000004, IntPtr.Zero, Path.GetDirectoryName(scriptPath), ref start, out process))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                session.Process = process.hProcess;
                session.ProcessId = checked((int)process.dwProcessId);
                try
                {
                    if (!Native.AssignProcessToJobObject(session.Job, session.Process))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not assign isolated worker to its cleanup job.");
                    if (Native.ResumeThread(process.hThread) == UInt32.MaxValue)
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                catch
                {
                    Native.TerminateProcess(session.Process, 1);
                    throw;
                }
                finally { Native.CloseHandle(process.hThread); }
                return session;
            }
            catch { session.Dispose(); throw; }
            finally { if (securityDescriptor != IntPtr.Zero) Native.LocalFree(securityDescriptor); }
        }

        public sealed class IsolationSession : IDisposable
        {
            internal IntPtr Desktop, Job, Process;
            private readonly Dictionary<int, IntPtr> ownedProcesses = new Dictionary<int, IntPtr>();
            private readonly Dictionary<int, ulong> ownedCpuSamples = new Dictionary<int, ulong>();
            private readonly Stopwatch cpuSampleClock = Stopwatch.StartNew();
            private bool disposed;
            public string ExpectedDesktop { get; internal set; }
            public int ProcessId { get; internal set; }
            public bool CleanupComplete { get; private set; }
            public bool HasExited
            {
                get
                {
                    if (Process == IntPtr.Zero) return true;
                    uint status = Native.WaitForSingleObject(Process, 0);
                    if (status == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                    return status == 0;
                }
            }
            public int ExitCode
            {
                get
                {
                    uint exitCode;
                    if (Process == IntPtr.Zero || !Native.GetExitCodeProcess(Process, out exitCode))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    return unchecked((int)exitCode);
                }
            }

            // Called by the launcher's watchdog. Only verified HWP handles
            // count: activity in PowerShell or the launcher cannot hide an idle
            // HWP dialog. Windows process CPU times use 100-nanosecond units.
            public bool HasOwnedProcessCpuActivity()
            {
                if (cpuSampleClock.ElapsedMilliseconds < 1000) return false;
                cpuSampleClock.Restart();
                bool activity = false;
                foreach (KeyValuePair<int, IntPtr> owned in ownedProcesses)
                {
                    ulong cpuTicks;
                    if (!TryReadCpuTicks(owned.Value, out cpuTicks)) continue;
                    ulong previous;
                    if (ownedCpuSamples.TryGetValue(owned.Key, out previous) &&
                        cpuTicks >= previous && cpuTicks - previous >= 1000000UL)
                        activity = true; // At least 100 ms CPU since last sample.
                    ownedCpuSamples[owned.Key] = cpuTicks;
                }
                return activity;
            }

            private static bool TryReadCpuTicks(IntPtr process, out ulong ticks)
            {
                Native.FILETIME creation, exit, kernel, user;
                ticks = 0;
                if (!Native.GetProcessTimes(process, out creation, out exit, out kernel, out user)) return false;
                ticks = (((ulong)kernel.dwHighDateTime << 32) | kernel.dwLowDateTime) +
                    (((ulong)user.dwHighDateTime << 32) | user.dwLowDateTime);
                return true;
            }
            public void RegisterIsolatedWindowProcess(int processId, long windowHandle)
            {
                if (Desktop == IntPtr.Zero || Job == IntPtr.Zero)
                    throw new ObjectDisposedException("IsolationSession");
                Exception failure = null;
                // HWND lookup is desktop-scoped. The interactive launcher must
                // not change its own desktop, and the COM thread must not change
                // its cached desktop either. Use a fresh thread with no windows
                // or hooks solely for ownership verification and Job assignment.
                Thread verifier = new Thread(delegate()
                {
                    try
                    {
                        if (!Native.SetThreadDesktop(Desktop))
                            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not associate the ownership verifier with the private desktop.");
                        RegisterIsolatedWindowProcessOnDesktop(processId, windowHandle);
                    }
                    catch (Exception error) { failure = error; }
                });
                verifier.IsBackground = true;
                verifier.Name = "Hangul conversion ownership verifier";
                verifier.Start();
                // Exit of this short-lived thread releases its desktop
                // association. The session owns the desktop handle throughout.
                verifier.Join();
                if (failure != null) ExceptionDispatchInfo.Capture(failure).Throw();
            }

            private void RegisterIsolatedWindowProcessOnDesktop(int processId, long windowHandle)
            {
                if (AssertWindowDesktop(windowHandle, ExpectedDesktop) != processId)
                    throw new InvalidOperationException("Isolation event process identity does not match its window.");
                if (ownedProcesses.ContainsKey(processId)) return;
                IntPtr process = Native.OpenProcess(0x00101101, false, checked((uint)processId));
                if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                try
                {
                    if (AssertWindowDesktop(windowHandle, ExpectedDesktop) != processId ||
                        Native.GetProcessId(process) != (uint)processId || Native.WaitForSingleObject(process, 0) != 258)
                        throw new InvalidOperationException("Isolated process changed while registering cleanup ownership.");
                    // COM-launched servers need not be children of PowerShell.
                    // A retained handle prevents PID reuse from targeting another process.
                    // Assign the independently verified COM server as well, so
                    // abrupt launcher shutdown cannot leave a registered server.
                    bool alreadyAssigned;
                    if (!Native.IsProcessInJob(process, Job, out alreadyAssigned))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (!alreadyAssigned && !Native.AssignProcessToJobObject(Job, process))
                    {
                        int assignmentError = Marshal.GetLastWin32Error();
                        Native.TerminateProcess(process, 1);
                        throw new Win32Exception(assignmentError, "Could not assign verified HWP process to its cleanup job.");
                    }
                    ownedProcesses.Add(processId, process);
                    ulong cpuTicks;
                    if (TryReadCpuTicks(process, out cpuTicks)) ownedCpuSamples[processId] = cpuTicks;
                }
                catch { Native.CloseHandle(process); throw; }
            }
            public void Terminate()
            {
                foreach (IntPtr process in ownedProcesses.Values)
                    if (Native.WaitForSingleObject(process, 0) == 258) Native.TerminateProcess(process, 130);
                if (Job != IntPtr.Zero) Native.TerminateJobObject(Job, 130);
                if (Process != IntPtr.Zero && Native.WaitForSingleObject(Process, 0) == 258)
                    Native.TerminateProcess(Process, 130);
            }
            public void Dispose()
            {
                if (disposed) return;
                disposed = true;
                bool complete = true;
                Stopwatch cleanupClock = Stopwatch.StartNew();
                try
                {
                    try { Terminate(); } catch { complete = false; }
                    // TerminateProcess is asynchronous. Replacement must wait
                    // for these exact retained processes to finish unloading.
                    // All waits share one five-second budget, including the child.
                    foreach (IntPtr process in ownedProcesses.Values)
                        if (!WaitForCleanupExit(process, cleanupClock)) complete = false;
                    if (Process != IntPtr.Zero && !WaitForCleanupExit(Process, cleanupClock)) complete = false;
                }
                catch { complete = false; }
                finally
                {
                    foreach (IntPtr process in ownedProcesses.Values)
                        if (!CloseCleanupHandle(process, false)) complete = false;
                    ownedProcesses.Clear();
                    ownedCpuSamples.Clear();
                    if (Process != IntPtr.Zero && !CloseCleanupHandle(Process, false)) complete = false;
                    Process = IntPtr.Zero;
                    if (Job != IntPtr.Zero && !CloseCleanupHandle(Job, false)) complete = false;
                    Job = IntPtr.Zero;
                    if (Desktop != IntPtr.Zero && !CloseCleanupHandle(Desktop, true)) complete = false;
                    Desktop = IntPtr.Zero;
                    CleanupComplete = complete;
                }
            }

            private static bool WaitForCleanupExit(IntPtr process, Stopwatch cleanupClock)
            {
                try
                {
                    uint remaining = (uint)Math.Max(0L, 5000L - cleanupClock.ElapsedMilliseconds);
                    return Native.WaitForSingleObject(process, remaining) == 0;
                }
                catch { return false; }
            }

            private static bool CloseCleanupHandle(IntPtr handle, bool desktop)
            {
                try { return desktop ? Native.CloseDesktop(handle) : Native.CloseHandle(handle); }
                catch { return false; }
            }
        }

        private static class Native
        {
            [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct STARTUPINFO
            {
                public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
                public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
                public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
            }
            [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
            [StructLayout(LayoutKind.Sequential)] internal struct FILETIME { public uint dwLowDateTime, dwHighDateTime; }
            [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
            {
                public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
                public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
                public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
            }
            [StructLayout(LayoutKind.Sequential)] internal struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
            [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            {
                public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
                public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
            }
            [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr GetProcessWindowStation();
            [DllImport("user32.dll", EntryPoint = "CreateDesktopW", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SECURITY_ATTRIBUTES security);
            [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseDesktop(IntPtr desktop);
            [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr GetThreadDesktop(uint threadId);
            [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetThreadDesktop(IntPtr desktop);
            [DllImport("user32.dll", SetLastError = true)] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
            [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetUserObjectInformation(IntPtr handle, int index, IntPtr info, int length, out int needed);
            [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
            [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
            [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
            [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
            [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
            [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
            [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
            [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
            [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint GetProcessId(IntPtr process);
            [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(IntPtr process, uint exitCode);
            [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateJobObject(IntPtr security, string name);
            [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
            [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
            [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
            [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateJobObject(IntPtr job, uint exitCode);
            [DllImport("advapi32.dll", EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
            [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr memory);
        }
    }
}
