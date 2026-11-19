# setup-pm2-startup.ps1  (Windows only)
#
# Makes ONE thing start pm2 on this machine, and puts it in your own logged-on
# session where windows can actually appear.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-pm2-startup.ps1
#
# Mac and Linux: use `pm2 startup` and `pm2 save` instead; this script is not
# needed there.
#
# ---------------------------------------------------------------------------
# Why one startup path, at logon, interactive
# ---------------------------------------------------------------------------
# It is easy to end up with several things starting pm2 (the pm2-windows-startup
# package writes a registry Run value; a hand-made scheduled task adds another).
# Two of them firing at once gives you two pm2 daemons, which means two copies
# of every app racing for the same port; the loser dies.
#
# A task set to run at BOOT, or "whether the user is logged on or not", puts
# the whole stack in Windows "session 0", the service session, which has no
# desktop. Chat and dispatch keep working, so nothing looks broken, but
# anything that has to SHOW something fails silently: clicking a project's
# folder path in the dashboard opens Explorer on a desktop nobody can see.
# Second tell: `pm2 list` from a normal shell fails with
# `connect EPERM //./pipe/rpc.sock`.
#
# So: one task, triggered at LOGON, running INTERACTIVE.
#
# ---------------------------------------------------------------------------
# What this script does
# ---------------------------------------------------------------------------
#   1. Registers the task "aiTeam pm2 Resurrect": at logon, +10s, interactive,
#      hidden window, runs `pm2 resurrect`.
#   2. Removes the registry Run value "PM2" if pm2-windows-startup left one
#      (backing it up to ~/.aiteam first).
#   3. Lists everything that still starts pm2. There should be exactly one.
#
# Idempotent. No admin rights needed. It registers a TASK and starts nothing.
# Registering pm2 APPS (`pm2 start ecosystem.config.js` then `pm2 save`) must be
# done from a clean shell with no PORT variable set: pm2 freezes the shell's
# environment into its saved list and replays it after every reboot.

$ErrorActionPreference = "Stop"

$taskName = "aiTeam pm2 Resurrect"
$user     = "$env:USERDOMAIN\$env:USERNAME"
$repoRoot = Split-Path -Parent $PSScriptRoot
$vbs      = Join-Path $PSScriptRoot "run-hidden.vbs"

# ---------------------------------------------------------------------------
# 1. The one startup task
# ---------------------------------------------------------------------------

$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw "node.exe is not on PATH. Install Node.js first." }

$pm2Bin = Join-Path $env:APPDATA "npm\node_modules\pm2\bin\pm2"
if (-not (Test-Path $pm2Bin)) {
    throw "pm2 not found at $pm2Bin. Install pm2 globally first (npm i -g pm2)."
}

# Interactive tasks show a console window for the lifetime of any console
# program they launch. wscript.exe and run-hidden.vbs start it with no window.
$action = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument "`"$vbs`" `"$nodeExe`" `"$pm2Bin`" `"resurrect`"" `
    -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = "PT10S"

# LogonType Interactive is the whole point: "run only when the user is logged
# on". The Password logon type is what puts the stack in session 0.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force `
    -Description "The only thing that starts pm2 on this machine. Runs 'pm2 resurrect' 10s after logon, in your interactive session so on-screen features work. See scripts/setup-pm2-startup.ps1 in the aiTeam folder." | Out-Null

Write-Output "OK  registered task: $taskName (logon +10s, interactive, hidden)"

# ---------------------------------------------------------------------------
# 2. The registry Run value
# ---------------------------------------------------------------------------

$runKey = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
$existing = (Get-ItemProperty -Path $runKey -Name "PM2" -ErrorAction SilentlyContinue).PM2

if ($existing) {
    # Back it up outside the repo, so restoring is a copy-paste.
    $backupDir = Join-Path $env:USERPROFILE ".aiteam"
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $backupFile = Join-Path $backupDir "pm2-run-key.backup.txt"
    @(
        "Removed from $runKey on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') by scripts/setup-pm2-startup.ps1.",
        "To restore:",
        "  Set-ItemProperty -Path '$runKey' -Name PM2 -Value '$existing'",
        "",
        "Original value:",
        $existing
    ) | Set-Content -Path $backupFile -Encoding utf8

    Remove-ItemProperty -Path $runKey -Name "PM2"
    Write-Output "OK  removed registry Run value 'PM2' (backed up to $backupFile)"
} else {
    Write-Output "--  registry Run value 'PM2' not present"
}

# ---------------------------------------------------------------------------
# 3. Summary
# ---------------------------------------------------------------------------

Write-Output ""
Write-Output "Things that start pm2 now:"
Get-ScheduledTask | Where-Object {
    $_.Actions.Arguments -match 'pm2' -or $_.Actions.Execute -match 'pm2'
} | ForEach-Object { "  task: $($_.TaskName)  [$($_.Principal.LogonType)]" }
$stillRun = (Get-ItemProperty -Path $runKey -Name "PM2" -ErrorAction SilentlyContinue).PM2
if ($stillRun) { Write-Output "  registry Run: PM2" }
Write-Output ""
Write-Output "That list should have exactly one entry: 'aiTeam pm2 Resurrect' [Interactive]."
Write-Output "If another task is listed, remove it in Task Scheduler."
