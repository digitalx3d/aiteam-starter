# verify-startup.ps1  (Windows only)
#
# Run this AFTER a restart. It answers one question in plain English: did the
# machine come back up with a single, correctly placed pm2 and a live dashboard?
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-startup.ps1
#
# Pairs with setup-pm2-startup.ps1, which makes one logon task ("aiTeam pm2
# Resurrect") the only thing that starts pm2.
#
# Use Restart, not shutdown then power on: with Windows Fast Startup enabled
# the two are not the same test.
#
# Read-only. It changes nothing.

$ErrorActionPreference = "Continue"

function Line($ok, $text) {
    $mark = if ($ok -eq $true) { "PASS" } elseif ($ok -eq $false) { "FAIL" } else { "----" }
    $color = if ($ok -eq $true) { "Green" } elseif ($ok -eq $false) { "Red" } else { "Gray" }
    Write-Host ("  [{0}] {1}" -f $mark, $text) -ForegroundColor $color
}

$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
Write-Host ""
Write-Host "Last boot: $boot  ($([int]((Get-Date) - $boot).TotalMinutes) minutes ago)" -ForegroundColor Cyan
Write-Host ""

# --- 1. Exactly one pm2 daemon, and it is in the visible session ------------
Write-Host "1. The pm2 daemon" -ForegroundColor Cyan
$daemons = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'pm2\\lib\\Daemon.js' })

if ($daemons.Count -eq 0) {
    Line $false "No pm2 daemon is running at all. Nothing came back up."
} else {
    Line ($daemons.Count -eq 1) "$($daemons.Count) pm2 daemon(s) running (want exactly 1)"
    foreach ($d in $daemons) {
        $inSession1 = ($d.SessionId -ne 0)
        Line $inSession1 "PID $($d.ProcessId) is in session $($d.SessionId) ($(if ($inSession1) { 'visible session, on-screen features work' } else { 'session 0, no desktop: folder-open will silently fail' }))"
    }
}

# --- 2. Only one thing is allowed to start pm2 ------------------------------
Write-Host ""
Write-Host "2. What starts pm2" -ForegroundColor Cyan
$starters = @()
Get-ScheduledTask | Where-Object {
    $_.Actions.Arguments -match 'pm2' -or $_.Actions.Execute -match 'pm2'
} | ForEach-Object { $starters += "scheduled task '$($_.TaskName)' [$($_.Principal.LogonType)]" }
$runKey = (Get-ItemProperty "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" -Name "PM2" -ErrorAction SilentlyContinue).PM2
if ($runKey) { $starters += "startup registry entry 'PM2'" }

Line ($starters.Count -eq 1) "$($starters.Count) mechanism(s) start pm2 (want exactly 1)"
foreach ($s in $starters) { Write-Host "         $s" -ForegroundColor Gray }

# --- 3. The dashboard -------------------------------------------------------
Write-Host ""
Write-Host "3. The dashboard" -ForegroundColor Cyan
# Same rule as the rest of the app: appPort from ~/.aiteam/settings.json, else
# 3900. Never the generic PORT variable.
$port = 3900
$settingsFile = Join-Path $env:USERPROFILE ".aiteam\settings.json"
if (Test-Path $settingsFile) {
    try {
        $s = Get-Content $settingsFile -Raw | ConvertFrom-Json
        if ($s.appPort) { $port = [int]$s.appPort }
    } catch { }
}
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
    Line $true "Dashboard is up on port $port (session $($proc.SessionId))"
} else {
    Line $false "Dashboard is DOWN (nothing listening on port $port)"
}

# --- 4. Startup timeline ----------------------------------------------------
Write-Host ""
Write-Host "4. What ran at logon (Task Scheduler log)" -ForegroundColor Cyan
try {
    Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational'; StartTime=$boot} -ErrorAction Stop |
        Where-Object { $_.Message -match 'pm2 Resurrect' } |
        Sort-Object TimeCreated |
        Select-Object -First 20 |
        ForEach-Object { Write-Host ("         {0:HH:mm:ss}  id {1}  {2}" -f $_.TimeCreated, $_.Id, ($_.Message -split "`r?`n")[0]) -ForegroundColor Gray }
} catch {
    Write-Host "         (no Task Scheduler events readable)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Everything PASS means startup is healthy." -ForegroundColor Cyan
Write-Host ""
