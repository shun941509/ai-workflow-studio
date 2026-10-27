/* Internal loader diagnosis only: no CRT, no Python execution and no permission changes. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static WCHAR root[32768], filePath[32768];
static char report[4096];
static unsigned int used;
static void append(const char* value) { while (*value && used < sizeof(report) - 1) report[used++] = *value++; }
static void number(DWORD value) { char digits[16]; int size = 0; do { digits[size++] = (char)('0' + value % 10); value /= 10; } while (value); while (size) { char one[2]; one[0] = digits[--size]; one[1] = 0; append(one); } }
static WCHAR* taskPath(const WCHAR* tail) { unsigned int index = 0; while (root[index]) { filePath[index] = root[index]; index++; } filePath[index++] = L'\\'; while (*tail) filePath[index++] = *tail++; filePath[index] = 0; return filePath; }
static void result(const char* name, DWORD code) { append("\""); append(name); append("\":"); number(code); append(","); }
/* Retain successful handles until process exit to test dependency resolution after explicit loading. */
static DWORD load(const WCHAR* filename) { HMODULE module = LoadLibraryExW(filename, 0, LOAD_WITH_ALTERED_SEARCH_PATH); return module ? 0 : GetLastError(); }
static DWORD loadApi(const WCHAR* name) { HMODULE module = LoadLibraryExW(name, 0, 0); return module ? 0 : GetLastError(); }
/* Resolve only named OS dependencies; do not search user PATH or inspect registry values. */
static DWORD systemLoad(const WCHAR* name) { static WCHAR systemPath[32768]; unsigned int length = GetSystemDirectoryW(systemPath, 32700); systemPath[length++] = L'\\'; while (*name) systemPath[length++] = *name++; systemPath[length] = 0; return load(systemPath); }
static DWORD read(const WCHAR* tail) { HANDLE file = CreateFileW(taskPath(tail), GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, 0); if (file == INVALID_HANDLE_VALUE) return GetLastError(); CloseHandle(file); return 0; }

/* Only the fixed executable/root grammar from SandboxHost is accepted. */
void ProbeEntry(void) {
    const WCHAR* command = GetCommandLineW();
    if (*command++ != L'"') ExitProcess(73); while (*command && *command != L'"') command++; if (*command++ != L'"') ExitProcess(73);
    while (*command == L' ') command++; if (*command++ != L'"') ExitProcess(73);
    unsigned int length = 0; while (*command && *command != L'"' && length < 32000) root[length++] = *command++; root[length] = 0;
    if (*command != L'"') ExitProcess(73);
    append("{");
    result("pythonDllRead", read(L"bin\\python314.dll"));
    result("crtRead", read(L"bin\\vcruntime140.dll"));
    result("crtLoad", load(taskPath(L"bin\\vcruntime140.dll")));
    result("versionLoad", systemLoad(L"VERSION.dll"));
    result("winsockLoad", systemLoad(L"WS2_32.dll"));
    result("pathApiLoad", loadApi(L"api-ms-win-core-path-l1-1-0.dll"));
    result("bcryptLoad", systemLoad(L"bcrypt.dll"));
    result("advapiLoad", systemLoad(L"ADVAPI32.dll"));
    result("ucrtLoad", systemLoad(L"ucrtbase.dll"));
    result("crtEnvironmentLoad", loadApi(L"api-ms-win-crt-environment-l1-1-0.dll"));
    result("crtStringLoad", loadApi(L"api-ms-win-crt-string-l1-1-0.dll"));
    result("crtConvertLoad", loadApi(L"api-ms-win-crt-convert-l1-1-0.dll"));
    result("crtTimeLoad", loadApi(L"api-ms-win-crt-time-l1-1-0.dll"));
    result("crtProcessLoad", loadApi(L"api-ms-win-crt-process-l1-1-0.dll"));
    result("crtConioLoad", loadApi(L"api-ms-win-crt-conio-l1-1-0.dll"));
    result("crtFilesystemLoad", loadApi(L"api-ms-win-crt-filesystem-l1-1-0.dll"));
    HMODULE raw = LoadLibraryExW(taskPath(L"bin\\python314.dll"), 0, DONT_RESOLVE_DLL_REFERENCES);
    result("pythonImageMap", raw ? 0 : GetLastError()); if (raw) FreeLibrary(raw);
    result("pythonDllLoad", load(taskPath(L"bin\\python314.dll")));
    append("\"completed\":true}");
    HANDLE file = CreateFileW(taskPath(L"output\\worker-report.json"), GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (file == INVALID_HANDLE_VALUE) ExitProcess(71); DWORD written; if (!WriteFile(file, report, used, &written, 0)) ExitProcess(72); CloseHandle(file); ExitProcess(0);
}
