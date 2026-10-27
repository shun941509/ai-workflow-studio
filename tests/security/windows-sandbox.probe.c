/* Internal OS-boundary fixture: imports Kernel32/Ws2_32/Advapi32, avoiding Node/USER32 loader assumptions.
 * It touches only the fresh task canaries created by verify-windows-sandbox.mjs. No shell is used. */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>

static WCHAR root[32768], filePath[32768];
static char report[4096];
static unsigned int reportLength;

static void append(const char* value) { while (*value && reportLength < sizeof(report) - 1) report[reportLength++] = *value++; }
static void number(DWORD value) { char digits[16]; int size = 0; do { digits[size++] = (char)('0' + value % 10); value /= 10; } while (value); while (size) { char one[2]; one[0] = digits[--size]; one[1] = 0; append(one); } }
static WCHAR* taskPath(const WCHAR* tail) { unsigned int index = 0; while (root[index]) { filePath[index] = root[index]; index++; } filePath[index++] = L'\\'; while (*tail) filePath[index++] = *tail++; filePath[index] = 0; return filePath; }
static DWORD readProbe(const WCHAR* tail) { HANDLE file = CreateFileW(taskPath(tail), GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, 0); if (file == INVALID_HANDLE_VALUE) return GetLastError(); char buffer[64]; DWORD read = 0; BOOL ok = ReadFile(file, buffer, sizeof(buffer), &read, 0); DWORD result = ok && read ? 0 : GetLastError(); CloseHandle(file); return result; }
static DWORD writeProbe(const WCHAR* tail) { HANDLE file = CreateFileW(taskPath(tail), GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0); if (file == INVALID_HANDLE_VALUE) return GetLastError(); DWORD written; BOOL ok = WriteFile(file, "sandbox output", 14, &written, 0); DWORD result = ok && written == 14 ? 0 : GetLastError(); CloseHandle(file); return result; }
static void result(const char* name, DWORD code) { append("\""); append(name); append("\":"); number(code); append(","); }
/* Opening these known key handles collects only access status, never values or user registry contents. */
static DWORD registryProbe(HKEY hive, const WCHAR* key) { HKEY opened; LSTATUS status = RegOpenKeyExW(hive, key, 0, KEY_READ, &opened); if (!status) RegCloseKey(opened); return status; }
static void save(void) { HANDLE file = CreateFileW(taskPath(L"output\\worker-report.json"), GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0); if (file == INVALID_HANDLE_VALUE) ExitProcess(71); DWORD written; if (!WriteFile(file, report, reportLength, &written, 0)) ExitProcess(72); CloseHandle(file); }

/* Entry uses the fixed quoted executable/root grammar emitted by the C# helper. No CRT or shell parser. */
void ProbeEntry(void)
{
    const WCHAR* command = GetCommandLineW();
    if (*command++ != L'"') ExitProcess(73); while (*command && *command != L'"') command++; if (*command++ != L'"') ExitProcess(73);
    while (*command == L' ') command++; if (*command++ != L'"') ExitProcess(73);
    unsigned int length = 0; while (*command && *command != L'"' && length < 32000) root[length++] = *command++; root[length] = 0;
    if (*command != L'"') ExitProcess(73);
    char mode[32]; DWORD bytes = 0;
    HANDLE modeFile = CreateFileW(taskPath(L"input\\native-mode.txt"), GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, 0);
    if (modeFile == INVALID_HANDLE_VALUE || !ReadFile(modeFile, mode, 31, &bytes, 0)) ExitProcess(74); CloseHandle(modeFile); mode[bytes] = 0;
    if (mode[0] == 't') { append("{\"started\":true}"); save(); Sleep(60000); ExitProcess(75); }
    if (mode[0] == 'c') { append("{\"started\":true}"); save(); volatile DWORD count = 0; for (;;) count++; }
    if (mode[0] == 'm') {
        for (DWORD index = 0; index < 40; index++) {
            reportLength = 0; append("{\"allocatedMiB\":"); number(index * 8); append("}"); save();
            unsigned char* allocation = (unsigned char*)VirtualAlloc(0, 8 * 1024 * 1024, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
            if (!allocation) { DWORD error = GetLastError(); reportLength = 0; append("{\"memoryDenied\":true,\"code\":"); number(error); append(",\"allocatedMiB\":"); number(index * 8); append("}"); save(); ExitProcess(0); }
            for (DWORD offset = 0; offset < 8 * 1024 * 1024; offset += 4096) allocation[offset] = 0xa5;
        }
        reportLength = 0; append("{\"escapedMemoryLimit\":true}"); save(); ExitProcess(0);
    }
    append("{"); result("input", readProbe(L"input\\allowed.txt")); result("output", writeProbe(L"output\\allowed.txt"));
    result("inputWrite", writeProbe(L"input\\allowed.txt")); result("outsideRead", readProbe(L"outside\\private.txt")); result("outsideWrite", writeProbe(L"outside\\new.txt")); result("allAppPackagesRead", readProbe(L"aap-canary\\readable-by-appcontainers.txt"));
    /* The local listener was positively reached by the parent before this Winsock access check. */
    DWORD port = 0; for (DWORD offset = 0; offset < bytes; offset++) if (mode[offset] >= '0' && mode[offset] <= '9') port = port * 10 + mode[offset] - '0';
    WSADATA data; DWORD networkError = WSAStartup(0x0202, &data);
    if (!networkError) {
        SOCKET socketHandle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (socketHandle == INVALID_SOCKET) networkError = WSAGetLastError();
        else { struct sockaddr_in address; address.sin_family = AF_INET; address.sin_port = htons((u_short)port); address.sin_addr.s_addr = htonl(0x7f000001); if (connect(socketHandle, (struct sockaddr*)&address, sizeof(address))) networkError = WSAGetLastError(); closesocket(socketHandle); }
        WSACleanup();
    }
    result("network", networkError);
    result("registryHklmOsVersion", registryProbe(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"));
    result("registryHkcuSoftware", registryProbe(HKEY_CURRENT_USER, L"Software"));
    result("registryHkcuExplorer", registryProbe(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer"));
    static WCHAR executable[32768]; GetModuleFileNameW(0, executable, 32768);
    STARTUPINFOW startup; PROCESS_INFORMATION child;
    volatile unsigned char* clear = (volatile unsigned char*)&startup; for (DWORD index = 0; index < sizeof(startup); index++) clear[index] = 0; startup.cb = sizeof(startup);
    BOOL created = CreateProcessW(executable, 0, 0, 0, FALSE, CREATE_NO_WINDOW, 0, 0, &startup, &child);
    DWORD childError = created ? 0 : GetLastError();
    if (created) { WaitForSingleObject(child.hProcess, 1000); CloseHandle(child.hThread); CloseHandle(child.hProcess); }
    result("child", childError); append("\"completed\":true}"); save(); ExitProcess(0);
}
