# Open a folder in Explorer AND put the window in front.
#
# Why this isn't just `explorer.exe <path>`: Windows deliberately refuses to let
# a background process steal focus. The dashboard is a background web server, so
# the Explorer window it launches opens correctly but lands at the BOTTOM of the
# window stack, hidden behind the browser. The documented way around it is to
# briefly attach our input queue to the thread that currently owns the
# foreground window, which makes Windows treat the activation as coming from the
# active app rather than from a background one.
#
# Also reuses an Explorer window already showing this folder instead of piling up
# duplicates.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File open-folder.ps1 -Path "C:\Code\aiTeam"
#
# Callers spawning this from Node must pass FORWARD slashes in both the script
# path and -Path. powershell.exe re-parses its own command line and strips
# backslashes out of unquoted arguments, so "C:\Code\aiTeam" arrives as
# "Z:GitHubaiTeam" and the whole thing fails silently. Forward slashes survive
# intact and Windows accepts them everywhere. See the API route for the caller.

param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "No such folder: $Path"
    exit 1
}

$target = ([IO.Path]::GetFullPath($Path)).TrimEnd('\')

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AiTeamFg {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    const int SW_RESTORE = 9;
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;

    public static void Raise(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);

        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint thisThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != 0 && fgThread != thisThread) {
            attached = AttachThreadInput(thisThread, fgThread, true);
        }
        try {
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
        } finally {
            if (attached) AttachThreadInput(thisThread, fgThread, false);
        }

        // Belt and braces: even when Windows denies keyboard focus, a trip
        // through TOPMOST and straight back off it still lifts the window to
        // the top of the z-order, so it is at least visible rather than buried.
        SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    }
}
"@

function Find-FolderWindow {
    param([string]$Folder)
    $shell = New-Object -ComObject Shell.Application
    foreach ($w in $shell.Windows()) {
        try {
            # The Windows() collection also carries browser windows, which have
            # no shell folder behind them; those throw and get skipped.
            $p = $w.Document.Folder.Self.Path
            if ($p -and ($p.TrimEnd('\') -ieq $Folder)) { return [IntPtr]$w.HWND }
        } catch {
            continue
        }
    }
    return [IntPtr]::Zero
}

$hwnd = Find-FolderWindow -Folder $target

if ($hwnd -eq [IntPtr]::Zero) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$target`"" | Out-Null
    # Explorer hands the request to the running shell process and exits, so
    # there is nothing to wait on; poll for the window to actually appear.
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
        $hwnd = Find-FolderWindow -Folder $target
        if ($hwnd -ne [IntPtr]::Zero) { break }
    }
}

if ($hwnd -eq [IntPtr]::Zero) {
    # The window never showed up under a matching path (mapped-drive aliasing,
    # a slow shell). It was still opened; we just can't raise it.
    exit 2
}

[AiTeamFg]::Raise($hwnd)
exit 0
