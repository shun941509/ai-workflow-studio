// Windows-only experimental host: LPAC token + per-task ACLs + Job limits.
// This executable is deliberately not registered as a Studio Runner capability.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class SandboxHost
{
    private const uint CREATE_SUSPENDED = 4, DETACHED_PROCESS = 8, CREATE_UNICODE_ENVIRONMENT = 0x400, EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    private const uint WAIT_TIMEOUT = 258, TOKEN_QUERY = 8;
    private const uint JOB_LIMIT_PROCESS_TIME = 2, JOB_LIMIT_ACTIVE_PROCESS = 8, JOB_LIMIT_PROCESS_MEMORY = 0x100, JOB_LIMIT_JOB_MEMORY = 0x200, JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400, JOB_LIMIT_KILL_ON_CLOSE = 0x2000;

    // CLI accepts only a fresh task directory and numeric limits. Worker source and arguments are files,
    // never an injected command string. The caller must verify code/package hashes before staging.
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 6 || (args[4] != "node" && args[4] != "native-probe" && args[4] != "python-embed" && args[4] != "wasmtime" && args[4] != "wasmtime-stdio") || (args[5] != "none" && args[5] != "registry-read-diagnostic")) throw new ArgumentException("Expected task directory, wall milliseconds, memory MiB, CPU milliseconds, fixed worker profile, explicit diagnostic capability policy");
            // Python is evaluated only with zero capabilities; it cannot silently inherit the
            // Node-only registry diagnostic workaround through this fixed profile selection.
            if (args[4] == "python-embed" && args[5] != "none") throw new ArgumentException("Python embedded profile requires zero capabilities");
            if (args[4].StartsWith("wasmtime", StringComparison.Ordinal) && args[5] != "none") throw new ArgumentException("Wasmtime profile requires zero capabilities");
#if !STUDIO_SANDBOX_DIAGNOSTICS
            // The normal binary cannot enable registryRead through CLI input. Only a separately
            // compiled internal diagnostic binary contains the capability derivation code.
            if (args[5] != "none") throw new ArgumentException("Diagnostic capability is absent from this binary");
#endif
            string root = ValidateRoot(args[0], args[4]);
            uint wall = ParseLimit(args[1], 100, 30000);
            uint memory = ParseLimit(args[2], 64, 1024);
            uint cpu = ParseLimit(args[3], 100, 30000);
            return Launch(root, wall, memory, cpu, args[4], args[5] == "registry-read-diagnostic");
        }
        catch (Exception error)
        {
            Win32Exception native = error as Win32Exception;
            Console.Error.WriteLine(error.GetType().Name + (native == null ? "" : "[" + native.NativeErrorCode + "]") + ": " + error.Message);
            return 70;
        }
    }

    private static uint ParseLimit(string text, uint min, uint max)
    {
        uint value;
        if (!UInt32.TryParse(text, out value) || value < min || value > max) throw new ArgumentException("Limit outside allowed range");
        return value;
    }

    // ACL changes are confined to a direct run-UUID sibling of this helper. Ancestors are inspected,
    // never modified. Reparse points/hard links are rejected before any ACL or process operation.
    private static string ValidateRoot(string input, string workerProfile)
    {
        string root = Path.GetFullPath(input).TrimEnd(Path.DirectorySeparatorChar);
        string ownDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        if (!String.Equals(Path.GetDirectoryName(root), ownDirectory, StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(Path.GetFileName(root), "^run-[a-f0-9]{32}$")) throw new ArgumentException("Task must be a direct run-UUID directory beside the helper");
        string cursor = root;
        while (cursor != null)
        {
            if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new IOException("Reparse point in task path");
            cursor = Path.GetDirectoryName(cursor);
        }
        CheckTree(root);
        foreach (string part in new[] { "bin", "input", "output", "outside", "aap-canary" })
            if (!Directory.Exists(Path.Combine(root, part))) throw new IOException("Missing staging directory: " + part);
        string[] required = workerProfile == "python-embed"
            ? new[] { "bin/python.exe", "bin/python314.dll", "bin/python314.zip", "bin/python314._pth", "bin/LICENSE.txt", "input/worker.py", "input/request.json" }
            : workerProfile == "wasmtime-stdio" ? new[] { "bin/wasmtime.exe", "bin/LICENSE", "input/worker.wat", "input/request.json" }
            : workerProfile == "wasmtime" ? new[] { "bin/wasmtime.exe", "bin/LICENSE", "input/worker.wat" }
            : workerProfile == "node" ? new[] { "bin/node.exe", "input/worker.mjs", "input/request.json" }
            : new[] { "bin/native-probe.exe", "input/native-mode.txt" };
        foreach (string file in required) if (!File.Exists(Path.Combine(root, file.Replace('/', Path.DirectorySeparatorChar)))) throw new IOException("Incomplete worker staging: " + file);
        if (workerProfile == "wasmtime-stdio" && new FileInfo(Path.Combine(root, "input", "request.json")).Length > 1024 * 1024) throw new IOException("Worker input exceeds fixed byte limit");
        if (Directory.GetFileSystemEntries(Path.Combine(root, "output")).Length != 0) throw new IOException("Output must be fresh and empty");
        return root;
    }

    private static void CheckTree(string path)
    {
        int count = 0; ulong bytes = 0; CheckTreeCore(path, 0, ref count, ref bytes);
    }

    private static void CheckTreeCore(string path, int depth, ref int count, ref ulong bytes)
    {
        if (depth > 32) throw new IOException("Staging tree depth limit exceeded");
        foreach (string entry in Directory.EnumerateFileSystemEntries(path))
        {
            if (++count > 10000) throw new IOException("Staging entry limit exceeded");
            FileAttributes attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Reparse point in staging");
            if ((attributes & FileAttributes.Directory) != 0) CheckTreeCore(entry, depth + 1, ref count, ref bytes);
            else
            {
                // A hard link could otherwise make a staging ACL change affect a non-staging file.
                using (FileStream file = new FileStream(entry, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    BY_HANDLE_FILE_INFORMATION information;
                    Check(GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(), out information), "GetFileInformationByHandle");
                    if (information.NumberOfLinks != 1) throw new IOException("Hard-linked staging file is forbidden");
                    bytes += ((ulong)information.SizeHigh << 32) | information.SizeLow;
                    if (bytes > 512UL * 1024 * 1024) throw new IOException("Staging byte limit exceeded");
                }
            }
        }
    }

    private static void BaseDirectoryAcl(string path, SecurityIdentifier sid, FileSystemRights rights, bool inherit)
    {
        DirectorySecurity acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        InheritanceFlags children = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        acl.SetOwner(user);
        foreach (SecurityIdentifier owner in new[] { user, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) })
            acl.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, children, PropagationFlags.None, AccessControlType.Allow));
        if (sid != null) acl.AddAccessRule(new FileSystemAccessRule(sid, rights, inherit ? children : InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(path, acl);
        // Files copied before the parent DACL changed must receive the resulting inherited policy.
        foreach (string entry in Directory.GetFiles(path, "*", SearchOption.AllDirectories))
        {
            FileSecurity fileAcl = new FileSecurity(); fileAcl.SetAccessRuleProtection(false, false);
            File.SetAccessControl(entry, fileAcl);
        }
    }

    private static void LabelLow(string path)
    {
        IntPtr descriptor = IntPtr.Zero, sacl;
        bool present, defaulted;
        try
        {
            Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)", 1, out descriptor, IntPtr.Zero), "Build low integrity label");
            Check(GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted), "Read low integrity label");
            uint status = SetNamedSecurityInfo(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (status != 0) throw new Win32Exception((int)status, "Set output low integrity label");
        }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }

    private static int Launch(string root, uint wall, uint memory, uint cpu, string workerProfile, bool registryReadDiagnostic)
    {
        string profile = "StudioIsolationTest." + Guid.NewGuid().ToString("N");
        IntPtr sid = IntPtr.Zero, job = IntPtr.Zero, token = IntPtr.Zero, attributes = IntPtr.Zero, environment = IntPtr.Zero, registryCapability = IntPtr.Zero;
        IntPtr privateDesktop = IntPtr.Zero, uiDescriptor = IntPtr.Zero, outputDirectoryGuard = IntPtr.Zero;
        List<IntPtr> allocations = new List<IntPtr>();
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool profileCreated = false, attributesInitialized = false, assigned = false, timedOut = false, outputLimitExceeded = false, jobClosedOnOutputLimit = false;
        bool boundedStdio = workerProfile == "wasmtime-stdio";
        uint exitCode = 0, processId = 0;
        long peakMemory = 0;
        FileStream workerOut = null, workerError = null;
        FileStream workerInput = null;
        BoundedCapture stdoutCapture = null, stderrCapture = null;
        Stopwatch elapsed = Stopwatch.StartNew();
        try
        {
            int hr = CreateAppContainerProfile(profile, profile, "Temporary Studio OS isolation verification", IntPtr.Zero, 0, out sid);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr); // Never reuse another profile on collision.
            profileCreated = true;
            SecurityIdentifier packageSid = new SecurityIdentifier(sid);
            // Only a new private desktop gets an ACL; existing station/desktop permissions are untouched.
            // The child receives basic object access, not hook, desktop-switch, or ACL-write rights.
            string stationName;
            string desktopName = "StudioIsolation." + Guid.NewGuid().ToString("N");
            string uiSddl = "D:P(A;;GA;;;" + WindowsIdentity.GetCurrent().User.Value + ")(A;;0x00020083;;;" + packageSid.Value + ")S:(ML;;NW;;;LW)";
            Check(ConvertStringSecurityDescriptorToSecurityDescriptor(uiSddl, 1, out uiDescriptor, IntPtr.Zero), "Build private UI descriptor");
            SECURITY_ATTRIBUTES uiSecurity = new SECURITY_ATTRIBUTES(); uiSecurity.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); uiSecurity.lpSecurityDescriptor = uiDescriptor;
            IntPtr existingStation = GetProcessWindowStation(); Check(existingStation != IntPtr.Zero, "GetProcessWindowStation");
            StringBuilder stationBuffer = new StringBuilder(512); uint stationSize;
            Check(GetUserObjectInformation(existingStation, 2, stationBuffer, 1024, out stationSize), "Get station name"); stationName = stationBuffer.ToString();
            privateDesktop = CreateDesktop(desktopName, null, IntPtr.Zero, 0, 0x000F01FF, ref uiSecurity); Check(privateDesktop != IntPtr.Zero, "Create private desktop");
            BaseDirectoryAcl(root, packageSid, FileSystemRights.ReadAndExecute, false);
            BaseDirectoryAcl(Path.Combine(root, "bin"), packageSid, FileSystemRights.ReadAndExecute, true);
            BaseDirectoryAcl(Path.Combine(root, "input"), packageSid, FileSystemRights.ReadAndExecute, true);
            BaseDirectoryAcl(Path.Combine(root, "output"), packageSid, FileSystemRights.Modify, true);
            BaseDirectoryAcl(Path.Combine(root, "outside"), null, 0, false);
            BaseDirectoryAcl(Path.Combine(root, "aap-canary"), new SecurityIdentifier("S-1-15-2-1"), FileSystemRights.ReadAndExecute, true);
            LabelLow(Path.Combine(root, "output"));
            CheckTree(root);

            // Restrictive job limits are installed before a suspended child can execute any code.
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_LIMIT_PROCESS_TIME | JOB_LIMIT_ACTIVE_PROCESS | JOB_LIMIT_PROCESS_MEMORY | JOB_LIMIT_JOB_MEMORY | JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_LIMIT_KILL_ON_CLOSE;
            limits.BasicLimitInformation.ActiveProcessLimit = 1;
            limits.BasicLimitInformation.PerProcessUserTimeLimit = ((long)cpu) * 10000;
            limits.ProcessMemoryLimit = new UIntPtr(((ulong)memory) * 1024 * 1024);
            limits.JobMemoryLimit = limits.ProcessMemoryLimit;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))), "SetInformationJobObject");
            uint uiRestrictions = 0xff;
            Check(SetInformationJobObjectUi(job, 4, ref uiRestrictions, 4), "Set job UI restrictions");

            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 4, 0, ref size);
            attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            Check(InitializeProcThreadAttributeList(attributes, 4, 0, ref size), "InitializeProcThreadAttributeList"); attributesInitialized = true;
            SECURITY_CAPABILITIES capabilities = new SECURITY_CAPABILITIES(); capabilities.AppContainerSid = sid;
            // An explicit diagnostic-only variant can initialize Winsock with registryRead. It never
            // grants a network capability and must not be described as a production privacy profile.
            if (registryReadDiagnostic)
            {
#if STUDIO_SANDBOX_DIAGNOSTICS
                registryCapability = DeriveSingleCapability("registryRead");
                SID_AND_ATTRIBUTES entry = new SID_AND_ATTRIBUTES(); entry.Sid = registryCapability; entry.Attributes = 4;
                capabilities.CapabilityCount = 1; capabilities.Capabilities = Allocate(entry, allocations);
#else
                throw new InvalidOperationException("Diagnostic capability unavailable");
#endif
            }
            IntPtr cap = Allocate(capabilities, allocations);
            AddAttribute(attributes, 0x20009, cap, Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            IntPtr lpac = Allocate(1, allocations); AddAttribute(attributes, 0x2000F, lpac, 4);
            IntPtr noChildren = Allocate(1, allocations); AddAttribute(attributes, 0x2000E, noChildren, 4);

            // Only these two newly created output-file handles are inheritable. No credential,
            // job, token, process, input-file or unrelated parent handle crosses this boundary.
            IntPtr outHandle, errorHandle, inputHandle = IntPtr.Zero;
            if (boundedStdio)
            {
                // Anonymous pipes apply backpressure. The guest receives no writable disk handle;
                // only bounded bytes retained by the parent are written after the child exits.
                // Pin the output directory and two CreateNew files before untrusted execution.
                // No FILE_SHARE_DELETE or FILE_SHARE_WRITE is granted on the result files, and
                // the parent never reopens a guest-controlled path when persisting captured bytes.
                outputDirectoryGuard = CreateFile(Path.Combine(root, "output"), 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                Check(outputDirectoryGuard != new IntPtr(-1), "Pin output directory");
                BY_HANDLE_FILE_INFORMATION outputDirectoryInfo;
                Check(GetFileInformationByHandle(outputDirectoryGuard, out outputDirectoryInfo), "Inspect pinned output directory");
                if ((outputDirectoryInfo.Attributes & 0x400) != 0) throw new IOException("Output directory is a reparse point");
                workerOut = new FileStream(Path.Combine(root, "output", "stdout.txt"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                workerError = new FileStream(Path.Combine(root, "output", "stderr.txt"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                stdoutCapture = new BoundedCapture(1024 * 1024); stderrCapture = new BoundedCapture(64 * 1024);
                outHandle = stdoutCapture.ClientHandle; errorHandle = stderrCapture.ClientHandle;
                workerInput = new FileStream(Path.Combine(root, "input", "request.json"), FileMode.Open, FileAccess.Read, FileShare.Read);
                inputHandle = workerInput.SafeFileHandle.DangerousGetHandle(); Check(SetHandleInformation(inputHandle, 1, 1), "Set input inherit flag");
            }
            else
            {
                workerOut = new FileStream(Path.Combine(root, "output", "stdout.txt"), FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite);
                workerError = new FileStream(Path.Combine(root, "output", "stderr.txt"), FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite);
                outHandle = workerOut.SafeFileHandle.DangerousGetHandle(); errorHandle = workerError.SafeFileHandle.DangerousGetHandle();
                Check(SetHandleInformation(outHandle, 1, 1), "Set stdout inherit flag"); Check(SetHandleInformation(errorHandle, 1, 1), "Set stderr inherit flag");
            }
            int handleCount = boundedStdio ? 3 : 2;
            IntPtr inherited = Marshal.AllocHGlobal(IntPtr.Size * handleCount); allocations.Add(inherited);
            Marshal.WriteIntPtr(inherited, 0, outHandle); Marshal.WriteIntPtr(inherited, IntPtr.Size, errorHandle);
            if (boundedStdio) Marshal.WriteIntPtr(inherited, IntPtr.Size * 2, inputHandle);
            AddAttribute(attributes, 0x20002, inherited, IntPtr.Size * handleCount);

            STARTUPINFOEX startup = new STARTUPINFOEX(); startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.lpAttributeList = attributes;
            startup.StartupInfo.lpDesktop = stationName + "\\" + desktopName;
            startup.StartupInfo.dwFlags = 0x100; startup.StartupInfo.hStdOutput = outHandle; startup.StartupInfo.hStdError = errorHandle;
            startup.StartupInfo.hStdInput = inputHandle;
            string executable = Path.Combine(root, "bin", workerProfile == "node" ? "node.exe" : workerProfile == "python-embed" ? "python.exe" : workerProfile.StartsWith("wasmtime", StringComparison.Ordinal) ? "wasmtime.exe" : "native-probe.exe");
            string output = Path.Combine(root, "output");
            // Environment is an allowlist; parent API keys, NODE_OPTIONS, user profile and PATH are not inherited.
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            // Windows resolves and redirects LOCALAPPDATA for the new AppContainer profile. Omitting
            // this non-secret OS path makes CreateProcess fail with ERROR_ENVVAR_NOT_FOUND (203).
            string env = "APPDATA=" + output + "\0LOCALAPPDATA=" + Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + "\0PATH=" + Path.Combine(windows, "System32") + "\0SystemDrive=" + Path.GetPathRoot(windows).TrimEnd('\\') + "\0SystemRoot=" + windows + "\0TEMP=" + output + "\0TMP=" + output + "\0USERPROFILE=" + output + "\0UV_THREADPOOL_SIZE=2\0WINDIR=" + windows + "\0\0";
            environment = Marshal.StringToHGlobalUni(env);
            // Staging links were rejected. Avoid Node realpath walks that would require granting read
            // metadata permission to C:\ and every user ancestor; those ancestors remain ungranted.
            // Python isolated mode ignores Python environment/user site paths; ._pth fixes stdlib
            // lookup to the staged runtime. -S/-B disable site hooks and bytecode writes explicitly.
            string command = workerProfile == "node" ? Quote(executable) + " --no-warnings --preserve-symlinks --preserve-symlinks-main " + Quote(Path.Combine(root, "input", "worker.mjs")) + " " + Quote(Path.Combine(root, "input", "request.json"))
                : workerProfile == "python-embed" ? Quote(executable) + " -I -S -B " + Quote(Path.Combine(root, "input", "worker.py")) + " " + Quote(Path.Combine(root, "input", "request.json"))
                : boundedStdio ? Quote(executable) + " run -C cache=n,parallel-compilation=n -W fuel=10000000,max-memory-size=16777216,max-table-elements=10000,max-instances=1,max-memories=1,max-tables=1,threads=n,shared-memory=n,component-model=n -S inherit-env=n,inherit-stdin=y,inherit-network=n,allow-ip-name-lookup=n,tcp=n,udp=n,http=n,threads=n,config=n,keyvalue=n,nn=n " + Quote(Path.Combine(root, "input", "worker.wat"))
                // Internal Wasmtime experiment: no cache, inherited secrets, network, extra host
                // imports or precompiled native input. Only the two fresh staging roots are preopened.
                : workerProfile == "wasmtime" ? Quote(executable) + " run -C cache=n,parallel-compilation=n -W fuel=10000000,max-memory-size=16777216,max-table-elements=10000,max-instances=1,max-memories=1,max-tables=1,threads=n,shared-memory=n -S inherit-env=n,inherit-stdin=n,inherit-network=n,allow-ip-name-lookup=n,tcp=n,udp=n,http=n,threads=n,config=n,keyvalue=n,nn=n --dir " + Quote(Path.Combine(root, "input") + "::/input") + " --dir " + Quote(Path.Combine(root, "output") + "::/output") + " " + Quote(Path.Combine(root, "input", "worker.wat"))
                : Quote(executable) + " " + Quote(root);
            Check(CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS, environment, output, ref startup, out process), "CreateProcess LPAC");
            if (boundedStdio) { stdoutCapture.Start(); stderrCapture.Start(); }
            processId = process.dwProcessId;
            Check(AssignProcessToJobObject(job, process.hProcess), "AssignProcessToJobObject"); assigned = true;
            Check(OpenProcessToken(process.hProcess, TOKEN_QUERY, out token), "OpenProcessToken");
            int isContainer = 0, returned;
            Check(GetTokenInformation(token, 29, ref isContainer, 4, out returned), "TokenIsAppContainer");
            if (isContainer != 1) throw new InvalidOperationException("Child token is not AppContainer");
            bool inJob; Check(IsProcessInJob(process.hProcess, job, out inJob), "IsProcessInJob");
            if (!inJob) throw new InvalidOperationException("Child not assigned to required job");
            if (ResumeThread(process.hThread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
            uint wait;
            if (boundedStdio)
            {
                Stopwatch running = Stopwatch.StartNew();
                do
                {
                    wait = WaitForSingleObject(process.hProcess, 25);
                    outputLimitExceeded = stdoutCapture.LimitExceeded || stderrCapture.LimitExceeded;
                    if (stdoutCapture.Failed || stderrCapture.Failed) throw new IOException("Bounded output capture failed");
                } while (wait == WAIT_TIMEOUT && !outputLimitExceeded && running.ElapsedMilliseconds < wall);
                timedOut = wait == WAIT_TIMEOUT && !outputLimitExceeded;
            }
            else wait = WaitForSingleObject(process.hProcess, wall);
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION observed;
            Check(QueryInformationJobObject(job, 9, out observed, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)), IntPtr.Zero), "Query job limits");
            if (wait == WAIT_TIMEOUT)
            {
                // Closing this sole private job handle exercises the kernel KILL_ON_JOB_CLOSE rule.
                // It does not enumerate or terminate unrelated processes or rely on PID reuse.
                timedOut = !outputLimitExceeded; jobClosedOnOutputLimit = outputLimitExceeded;
                Check(CloseHandle(job), "Close limited job"); job = IntPtr.Zero; assigned = false;
                if (WaitForSingleObject(process.hProcess, 5000) != 0) throw new InvalidOperationException("Job close failed to terminate its child");
            }
            else if (wait != 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
            Check(GetExitCodeProcess(process.hProcess, out exitCode), "GetExitCodeProcess");
            if (boundedStdio)
            {
                stdoutCapture.Complete(); stderrCapture.Complete();
                outputLimitExceeded = stdoutCapture.LimitExceeded || stderrCapture.LimitExceeded;
                // Never publish these bytes as a successful Worker result when a stream exceeded its limit.
                byte[] capturedOut = stdoutCapture.Bytes, capturedError = stderrCapture.Bytes;
                workerOut.Write(capturedOut, 0, capturedOut.Length); workerOut.Flush(true);
                workerError.Write(capturedError, 0, capturedError.Length); workerError.Flush(true);
                workerOut.Dispose(); workerOut = null; workerError.Dispose(); workerError = null;
            }
            else { workerOut.Dispose(); workerOut = null; workerError.Dispose(); workerError = null; }
            // Untrusted output must not turn result collection into a junction/hard-link traversal.
            CheckTree(Path.Combine(root, "output"));
            peakMemory = checked((long)observed.PeakJobMemoryUsed.ToUInt64());
            if (observed.BasicLimitInformation.ActiveProcessLimit != 1 || observed.ProcessMemoryLimit != limits.ProcessMemoryLimit || observed.BasicLimitInformation.LimitFlags != limits.BasicLimitInformation.LimitFlags) throw new InvalidOperationException("Job limits differ from requested policy");
        }
        finally
        {
            // Handles are private and non-inheritable. Only this host's child/job can be terminated.
            if (process.hProcess != IntPtr.Zero)
            {
                uint current;
                if (GetExitCodeProcess(process.hProcess, out current) && current == 259)
                {
                    if (assigned) TerminateJobObject(job, 125); else TerminateProcess(process.hProcess, 125);
                    WaitForSingleObject(process.hProcess, 5000);
                }
            }
            if (token != IntPtr.Zero) CloseHandle(token);
            if (workerOut != null) workerOut.Dispose();
            if (workerError != null) workerError.Dispose();
            if (workerInput != null) workerInput.Dispose();
            if (stdoutCapture != null) stdoutCapture.Dispose();
            if (stderrCapture != null) stderrCapture.Dispose();
            if (outputDirectoryGuard != IntPtr.Zero && outputDirectoryGuard != new IntPtr(-1)) CloseHandle(outputDirectoryGuard);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            foreach (IntPtr allocation in allocations) Marshal.FreeHGlobal(allocation);
            if (registryCapability != IntPtr.Zero) LocalFree(registryCapability);
            if (privateDesktop != IntPtr.Zero) CloseDesktop(privateDesktop);
            if (uiDescriptor != IntPtr.Zero) LocalFree(uiDescriptor);
            if (sid != IntPtr.Zero) FreeSid(sid);
            if (profileCreated)
            {
                int result = DeleteAppContainerProfile(profile);
                if (result != 0) throw new COMException("Temporary AppContainer profile cleanup failed: " + profile, result);
            }
        }
        elapsed.Stop();
        Console.WriteLine("{\"processId\":" + processId + ",\"exitCode\":" + exitCode + ",\"timedOut\":" + (timedOut ? "true" : "false") + ",\"jobClosedOnTimeout\":" + (timedOut ? "true" : "false") + ",\"outputLimitExceeded\":" + (outputLimitExceeded ? "true" : "false") + ",\"jobClosedOnOutputLimit\":" + (jobClosedOnOutputLimit ? "true" : "false") + ",\"boundedStdio\":" + (boundedStdio ? "true" : "false") + ",\"elapsedMs\":" + elapsed.ElapsedMilliseconds + ",\"peakJobMemoryBytes\":" + peakMemory + ",\"appContainer\":true,\"lpacOptOut\":true,\"capabilities\":" + (registryReadDiagnostic ? "[\"registryRead\"]" : "[]") + ",\"privateDesktop\":true,\"networkCapabilityCount\":0,\"activeProcessLimit\":1,\"profileDeleted\":true}");
        return 0;
    }

    // A bounded capture never spools untrusted output to disk. It stops draining on overflow,
    // so the small OS pipe blocks the guest until the supervising thread closes the Job.
    private sealed class BoundedCapture : IDisposable
    {
        private readonly AnonymousPipeServerStream pipe;
        private readonly MemoryStream buffer;
        private readonly int maximum;
        private Thread reader;
        public volatile bool LimitExceeded;
        public volatile bool Failed;
        public IntPtr ClientHandle { get { return pipe.ClientSafePipeHandle.DangerousGetHandle(); } }
        public byte[] Bytes { get { return buffer.ToArray(); } }
        public BoundedCapture(int limit)
        {
            maximum = limit; buffer = new MemoryStream();
            pipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable, 4096);
        }
        public void Start()
        {
            // Once CreateProcess duplicated the handle, retaining this parent copy would prevent EOF.
            pipe.DisposeLocalCopyOfClientHandle();
            reader = new Thread(Read); reader.IsBackground = true; reader.Start();
        }
        private void Read()
        {
            try
            {
                byte[] chunk = new byte[4096]; int length;
                while ((length = pipe.Read(chunk, 0, chunk.Length)) > 0)
                {
                    int remaining = maximum - checked((int)buffer.Length);
                    if (length > remaining)
                    {
                        if (remaining > 0) buffer.Write(chunk, 0, remaining);
                        LimitExceeded = true; return;
                    }
                    buffer.Write(chunk, 0, length);
                }
            }
            catch (IOException) { Failed = true; }
            catch (ObjectDisposedException) { Failed = true; }
        }
        public void Complete()
        {
            if (reader != null && !reader.Join(5000)) throw new IOException("Output pipe did not reach EOF after child exit");
            if (Failed) throw new IOException("Output pipe capture failed");
        }
        public void Dispose()
        {
            pipe.Dispose();
            if (reader != null && reader.IsAlive) reader.Join(1000);
            buffer.Dispose();
        }
    }

    private static string Quote(string argument)
    {
        if (argument.IndexOf('"') >= 0 || argument.IndexOf('\0') >= 0 || argument.EndsWith("\\", StringComparison.Ordinal)) throw new ArgumentException("Invalid fixed command path");
        return "\"" + argument + "\"";
    }
#if STUDIO_SANDBOX_DIAGNOSTICS
    private static IntPtr DeriveSingleCapability(string name)
    {
        IntPtr groups = IntPtr.Zero, capabilities = IntPtr.Zero, kept = IntPtr.Zero; uint groupCount = 0, count = 0;
        try
        {
            Check(DeriveCapabilitySidsFromName(name, out groups, out groupCount, out capabilities, out count), "DeriveCapabilitySidsFromName");
            if (count != 1) throw new InvalidOperationException("Capability derivation returned unexpected count");
            kept = Marshal.ReadIntPtr(capabilities); return kept;
        }
        finally
        {
            for (int index = 0; index < groupCount; index++) LocalFree(Marshal.ReadIntPtr(groups, index * IntPtr.Size));
            if (groups != IntPtr.Zero) LocalFree(groups);
            for (int index = 0; index < count; index++) { IntPtr value = Marshal.ReadIntPtr(capabilities, index * IntPtr.Size); if (value != kept) LocalFree(value); }
            if (capabilities != IntPtr.Zero) LocalFree(capabilities);
        }
    }
#endif
    private static IntPtr Allocate(object value, List<IntPtr> allocations) { IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf(value)); allocations.Add(pointer); Marshal.StructureToPtr(value, pointer, false); return pointer; }
    private static void AddAttribute(IntPtr list, int key, IntPtr value, int length) { Check(UpdateProcThreadAttribute(list, 0, new UIntPtr((uint)key), value, new UIntPtr((uint)length), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute " + key); }
    private static void Check(bool success, string action) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), action); }

    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid, Capabilities; public uint CapabilityCount, Reserved; }
    [StructLayout(LayoutKind.Sequential)] private struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] private struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] private struct BY_HANDLE_FILE_INFORMATION { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint VolumeSerial, SizeHigh, SizeLow, NumberOfLinks, IndexHigh, IndexLow; }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int DeleteAppContainerProfile(string name);
#if STUDIO_SANDBOX_DIAGNOSTICS
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr capabilities, out uint count);
#endif
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateDesktop(string name, string device, IntPtr mode, uint flags, uint access, ref SECURITY_ATTRIBUTES security);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder information, uint size, out uint needed);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("advapi32.dll")] private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int informationClass, ref int information, int size, out int returned);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] private static extern uint SetNamedSecurityInfo(string name, uint type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint size);
    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)] private static extern bool SetInformationJobObjectUi(IntPtr job, int kind, ref uint information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int kind, out JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(IntPtr file, out BY_HANDLE_FILE_INFORMATION information);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr pointer);
}
