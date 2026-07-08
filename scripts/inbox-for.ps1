# inbox-for.ps1 -- read shared inbox entries addressed to a specific agent
#
# Returns the inbox-shared.md entries addressed to <Agent> that have an id
# greater than the agent's last_read_id. Optionally updates the read state.
#
# Usage:
#   powershell -NoProfile -File inbox-for.ps1 -Agent indy              # print unread, do NOT mark
#   powershell -NoProfile -File inbox-for.ps1 -Agent indy -MarkRead    # print AND mark as read
#
# Address semantics:
#   - An entry is addressed to <Agent> if its `to:` field contains the agent's
#     lowercase name OR the literal token "all" (broadcast).
#   - Entries with no `to:` field are skipped (treated as informational only).
#
# Id format: YYYY-MM-DDTHHMM-<from>-<slug>. Lexicographic comparison works.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, Position=0)][string]$Agent,
    [switch]$MarkRead,
    # Default: inbox-shared.md at the repo root (this script lives in <repo>\scripts\).
    # Resolved in the body — $PSScriptRoot is not reliable in param defaults on PS 5.1.
    [string]$InboxPath = ""
)

$ErrorActionPreference = "Stop"
if (-not $InboxPath) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $InboxPath = Join-Path (Split-Path -Parent $scriptDir) "inbox-shared.md"
}
$agentLower = $Agent.ToLower()
# CVB's persona folder is `claude/` not `cvb/` (historical). Map for state-file lookup.
$folderName = if ($agentLower -eq "cvb") { "claude" } else { $agentLower }
# Personas folder: ~/.aiteam/settings.json agentsDir if set, else ~\.claude\agents.
$AgentsRoot = Join-Path $env:USERPROFILE ".claude\agents"
$SettingsPath = Join-Path $env:USERPROFILE ".aiteam\settings.json"
if (Test-Path $SettingsPath) {
    try {
        $cfg = Get-Content $SettingsPath -Raw | ConvertFrom-Json
        if ($cfg.agentsDir) { $AgentsRoot = [string]$cfg.agentsDir }
    } catch { }
}
$StateDir   = Join-Path $AgentsRoot $folderName
$StatePath  = Join-Path $StateDir "inbox-state.json"

# Load state (or initialize)
$lastReadId = "0000-00-00T0000-init"
if (Test-Path $StatePath) {
    try {
        $state = Get-Content $StatePath -Raw | ConvertFrom-Json
        if ($state.last_read_id) { $lastReadId = [string]$state.last_read_id }
    } catch {
        Write-Warning "Could not parse $StatePath -- using default last_read_id"
    }
}

# Parse inbox
if (-not (Test-Path $InboxPath)) {
    Write-Output "(inbox-shared.md not found at $InboxPath)"
    exit 0
}
$content = Get-Content $InboxPath -Raw
# Entries are separated by lines containing only "---"
$parts = $content -split "(?m)^---\s*$"
# First part is file header (before any ---); rest are entries
$entries = $parts | Select-Object -Skip 1 | Where-Object { $_.Trim().Length -gt 0 }

$unread = @()
$newestId = $lastReadId

foreach ($entry in $entries) {
    $idMatch = [regex]::Match($entry, '\*\*id:\*\*\s*([^\s*\n]+)')
    $toMatch = [regex]::Match($entry, '\*\*to:\*\*\s*([^*\n]+?)(?=\s*[\*\n]|$)')

    if (-not $idMatch.Success) { continue }  # skip un-tagged entries (pre-convention)
    $id = $idMatch.Groups[1].Value.Trim()
    $to = if ($toMatch.Success) { $toMatch.Groups[1].Value.Trim() } else { "" }

    # Tokenize `to:` field on commas and whitespace
    $toTokens = $to -split '[,\s·]+' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }
    $addressed = $toTokens -contains $agentLower -or $toTokens -contains "all"
    if (-not $addressed) { continue }

    if ($id -le $lastReadId) { continue }

    $unread += [pscustomobject]@{ Id = $id; Content = $entry.TrimStart() }
    if ([string]::Compare($id, $newestId) -gt 0) { $newestId = $id }
}

if ($unread.Count -eq 0) {
    Write-Output "(no new entries for $agentLower since $lastReadId)"
    exit 0
}

# Print unread, newest first (entries are already newest-first in the file)
foreach ($u in $unread) {
    Write-Output "---"
    Write-Output $u.Content.TrimEnd()
    Write-Output ""
}

if ($MarkRead) {
    if (-not (Test-Path $StateDir)) {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    }
    $newState = [pscustomobject]@{ last_read_id = $newestId } | ConvertTo-Json
    [System.IO.File]::WriteAllText($StatePath, $newState, [System.Text.UTF8Encoding]::new($false))
    Write-Output "[MARKED-READ: $($unread.Count) entries; last_read_id = $newestId]"
}
