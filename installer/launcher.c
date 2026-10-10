#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nShowCmd) {
    char path[MAX_PATH];
    GetModuleFileNameA(NULL, path, MAX_PATH);
    char* lastSlash = strrchr(path, '\\');
    if (lastSlash) *lastSlash = '\0';

    char dest[MAX_PATH];
    snprintf(dest, sizeof(dest), "%s\\RunContainer", getenv("ProgramFiles"));

    CreateDirectoryA(dest, NULL);
    char src[MAX_PATH];
    snprintf(src, sizeof(src), "%s\\RunContainer-win32-x64", path);

    char cmd[MAX_PATH * 4];
    snprintf(cmd, sizeof(cmd), "xcopy /E /I \"%s\" \"%s\\\" >nul", src, dest);
    system(cmd);

    char exe[MAX_PATH];
    snprintf(exe, sizeof(exe), "%s\\RunContainer.exe", dest);
    ShellExecuteA(NULL, "open", exe, NULL, NULL, SW_SHOWNORMAL);
    return 0;
}
