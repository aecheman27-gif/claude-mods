<#
.SYNOPSIS
  Installs the my-claude-mods marketplace into Claude Code (user scope).

.DESCRIPTION
  1. Checks every name in -Exclude and -Disable before it changes anything.
     hw-write-guard is left out or switched off only with -AllowNoHwGuard.
  2. Copies this bundle to -Dest (default: $HOME\src\claude-mods).
  3. Validates the marketplace and every mod with `claude plugin validate`.
  4. Runs each mod's tests with `claude plugin test` (skip with -SkipTests).
     A failure in one of this marketplace's own mods stops the install; a failure in a
     vendored mod (its upstream tests) is reported as a warning.
  5. Adds the "my-claude-mods" marketplace (or refreshes it when it already
     points at -Dest) and installs the mods, switching each one in -Disable off right
     after its install. savvy-progress is installed switched off unless -EnableSavvyProgress.
  6. Lists enabled copies of the installed mods from other marketplaces (upstream
     cache-tax, redact, blast-radius, ...) and token-weather, and disables them only
     with -DisableClashes.
  Stops at the first failure. Works in Windows PowerShell 5.1 and PowerShell 7.

.EXAMPLE
  .\install.ps1 -DryRun                      # validate and test, change nothing
  .\install.ps1                              # do it
  .\install.ps1 -Exclude cc-arcade -Disable filetree
  .\install.ps1 -Exclude "cc-arcade,savvy-progress" -DisableClashes
#>
[CmdletBinding()]
param(
  [string]$Dest = (Join-Path $HOME 'src\claude-mods'),
  [string[]]$Exclude = @(),
  [string[]]$Disable = @(),
  [switch]$SkipTests,
  [switch]$DisableClashes,
  [switch]$EnableSavvyProgress,
  [switch]$AllowNoHwGuard,
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path   # the bundle root holds .claude-plugin\marketplace.json
$Dest = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dest).TrimEnd('\', '/')   # 5.1 passes "C:\my mods\" to claude as C:\my mods"
$Market = 'my-claude-mods'
$TestedFrom = '2.1.295'
$TestedTo = '2.1.300'
$Guard = 'hw-write-guard'
$OffByDefault = 'savvy-progress'   # plan-progress and flightdeck cover it, and it can hide other mods' band rows
$Extra = @('token-weather')   # not in this bundle, but its band row hides other mods' rows
# `-Exclude a,b` through `powershell -File` arrives as one string: split it
$split = { param($list) @($list | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$Exclude = @(& $split $Exclude)
$Disable = @(& $split $Disable)

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Warn($text) { Write-Host "  WARNING: $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "STOPPED: $text" -ForegroundColor Red; exit 1 }
function Run([string[]]$argv, [switch]$Mutates) {
  if ($DryRun -and $Mutates) { Write-Host "  [dry run] claude $($argv -join ' ')" -ForegroundColor DarkGray; return @{ code = 0; out = '' } }
  $ErrorActionPreference = 'Continue'   # 5.1 turns a native command's stderr into an error record under 'Stop'
  # claude writes UTF-8; decoded with the console's code page, a path under C:\Users\<non-ASCII name> comes back garbled
  $enc = [Console]::OutputEncoding
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
  try { $out = & claude @argv 2>&1 | ForEach-Object { "$_" } | Out-String }
  finally { [Console]::OutputEncoding = $enc }
  return @{ code = $LASTEXITCODE; out = $out }
}
function Json([string[]]$argv) {
  $r = Run $argv
  if ($r.code -ne 0) { Write-Host $r.out; Fail "claude $($argv -join ' ') failed." }
  $parsed = $r.out | ConvertFrom-Json   # 5.1 emits a JSON array as one object; returning the variable unrolls it
  return $parsed
}
function SamePath($a, $b) { ([IO.Path]::GetFullPath($a).TrimEnd('\')) -ieq ([IO.Path]::GetFullPath($b).TrimEnd('\')) }

Step 'Claude Code'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail 'claude is not on PATH.' }
$r = Run @('--version')
if ($r.code -ne 0) { Write-Host $r.out; Fail 'claude --version failed.' }
$version = ($r.out.Trim() -split ' ')[0]
Write-Host "  claude $version (these mods were tested on $TestedFrom through $TestedTo)"
$v = $version -as [version]
if (-not $v -or $v -lt [version]$TestedFrom -or $v -gt [version]$TestedTo) { Warn 'different version: the validate and test steps below are what tell whether the mods still fit.' }
$known = @(Json @('plugin', 'marketplace', 'list', '--json')) | Where-Object { $_.name -eq $Market }
if ($known) {
  $at = if ($known.path) { $known.path } else { $known.installLocation }
  if (-not (SamePath $at $Dest) -and -not $DryRun) { Fail "$Market is already registered at $at, not $Dest. Remove it first: claude plugin marketplace remove $Market" }
  if (-not (SamePath $at $Dest)) { Warn "$Market is registered at $at; a real run copies to $Dest, which must match it." }
}

# Every name is checked here, before anything is copied, added or installed
Step 'Mods'
if (-not (Test-Path -LiteralPath (Join-Path $Source '.claude-plugin\marketplace.json'))) { Fail "no marketplace.json under $Source; run this script from the unzipped bundle's work-bundle folder." }
$all = (Get-Content -LiteralPath (Join-Path $Source '.claude-plugin\marketplace.json') -Raw -Encoding UTF8 | ConvertFrom-Json).plugins
$unknown = @($Exclude + $Disable | Where-Object { $_ -ne 'reflect-mod' -and ($all.name -notcontains $_) })
if ($unknown) { Fail "no mod named: $($unknown -join ', ')" }
if ($Disable -contains 'reflect-mod') { Fail 'reflect-mod is never installed (reflect-lite replaces it), so it cannot be disabled.' }
$both = @($Disable | Where-Object { $Exclude -contains $_ })
if ($both) { Fail "both excluded and disabled: $($both -join ', '). -Exclude leaves a mod out; -Disable installs it switched off. Pick one." }
if (($Exclude + $Disable) -contains $Guard -and -not $AllowNoHwGuard) {
  Fail "$Guard asks before code that writes to hardware (nidaqmx DO/AO, pymodbus, pyserial, printer MQTT) runs. Without it, Claude can drive attached lab hardware without asking. Leave it in. Only if the user confirms this machine has no hardware attached, or wants the guard off anyway, re-run with -AllowNoHwGuard."
}
if ($EnableSavvyProgress -and ($Exclude + $Disable) -contains $OffByDefault) { Fail "-EnableSavvyProgress and -Exclude/-Disable $OffByDefault contradict each other. Pick one." }
$Exclude += 'reflect-mod'
if (-not $EnableSavvyProgress -and $all.name -contains $OffByDefault -and ($Exclude + $Disable) -notcontains $OffByDefault) { $Disable += $OffByDefault }
$mods = @($all | Where-Object { $Exclude -notcontains $_.name })
Write-Host "  mods: $(($mods | ForEach-Object name) -join ', ')"
if ($Disable) { Write-Host "  installed switched off: $($Disable -join ', ')" }
if ($Exclude -contains $Guard -or $Disable -contains $Guard) { Warn "$Guard is off (-AllowNoHwGuard): nothing asks before code writes to hardware." }

Step "Copy to $Dest"
if (SamePath $Source $Dest) { Write-Host '  already in place' }
else {
  if (Test-Path -LiteralPath $Dest) {
    if (-not $Force -and -not $DryRun) { Fail "$Dest already exists. Re-run with -Force to move it aside (to $Dest.bak-<time>) and copy fresh." }
    $aside = "$Dest.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    if ($DryRun) { Write-Host "  [dry run] $Dest exists: with -Force it would move to $aside" }
    else { Move-Item -LiteralPath $Dest -Destination $aside; Write-Host "  moved the old copy to $aside" }
  }
  if ($DryRun) { Write-Host "  [dry run] copy $Source -> $Dest" }
  else {
    New-Item -ItemType Directory -Force (Split-Path -Parent $Dest) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Dest -Recurse
    Write-Host '  copied'
  }
}
$Root = if ($DryRun) { $Source } else { $Dest }

Step 'Validate'
$r = Run @('plugin', 'validate', $Root)
if ($r.code -ne 0) { Write-Host $r.out; Fail 'the marketplace did not validate.' }
foreach ($m in $mods) {
  $r = Run @('plugin', 'validate', (Join-Path $Root $m.name))
  if ($r.code -ne 0) { Write-Host $r.out; Fail "$($m.name) did not validate." }
  Write-Host "  ok  $($m.name)"
}

if (-not $SkipTests) {
  Step 'Tests'
  foreach ($m in $mods) {
    $dir = Join-Path $Root $m.name
    $isVendored = "$($m.description)" -like 'Vendored from*'
    $tests = Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.test\.tsx?$' -and $_.FullName -notmatch 'node_modules' }
    if (-not $tests) { Write-Host "  --  $($m.name) (no tests)"; continue }
    $r = Run @('plugin', 'test', $dir)
    $summary = ($r.out -split "`r?`n" | Where-Object { $_ -match '^\s*\d+ (pass|fail)\s*$' } | ForEach-Object { $_.Trim() }) -join ', '
    if ($r.code -eq 0) { Write-Host "  ok  $($m.name)  $summary"; continue }
    if ($isVendored) { Warn "$($m.name) (vendored): its upstream tests did not all pass under ``claude plugin test`` ($summary). Installing it anyway." ; continue }
    Write-Host $r.out
    if ($m.name -eq $Guard) { Fail "$Guard tests failed. Fix it before installing: it is the guard for the lab hardware." }
    Fail "$($m.name) tests failed. Fix it, or re-run with -Exclude $($m.name)."
  }
}

Step "Marketplace $Market"
if ($known) { $r = Run @('plugin', 'marketplace', 'update', $Market) -Mutates }
else { $r = Run @('plugin', 'marketplace', 'add', $Root) -Mutates }
if ($r.code -ne 0) { Write-Host $r.out; Fail 'could not add or update the marketplace.' }
Write-Host '  ready'

Step 'Install'
foreach ($m in $mods) {
  $id = "$($m.name)@$Market"
  $r = Run @('plugin', 'install', $id, '--scope', 'user') -Mutates
  if ($r.code -ne 0 -and $r.out -notmatch 'already installed') { Write-Host $r.out; Fail "install of $($m.name) failed." }
  Write-Host "  ok  $($m.name)"
  # switched right after its own install, so a later failure can't leave it on
  if ($Disable -contains $m.name) { $verb = 'disable' }
  elseif ($m.name -eq $OffByDefault) { $verb = 'enable' }   # -EnableSavvyProgress, also when a re-run finds it off
  else { continue }
  $entry = Json @('plugin', 'list', '--json') | Where-Object { $_.id -eq $id -and $_.scope -eq 'user' }
  $on = -not $entry -or $entry.enabled   # missing only in a dry run, where the install would switch it on
  if ($on -ne ($verb -eq 'enable')) {
    $r = Run @('plugin', $verb, $id, '--scope', 'user') -Mutates
    if ($r.code -ne 0) { Write-Host $r.out; Fail "could not $verb $($m.name)." }
  }
  Write-Host "  $($verb)d $($m.name)"
}

Step 'Other copies of these mods'
# the mods installed above, under any other marketplace, plus token-weather
$Clashing = @($mods | ForEach-Object name) + $Extra
$clash = @(Json @('plugin', 'list', '--json') | Where-Object {
    $_.enabled -and ($_.id -split '@')[1] -ne $Market -and $Clashing -contains ($_.id -split '@')[0]
  })
if (-not $clash) { Write-Host '  none enabled' }
else {
  foreach ($c in $clash) { Write-Host "  $($c.id) ($($c.scope) scope)" }
  if (-not $DisableClashes) {
    Warn "these copies run alongside this bundle's: two cache-tax drop a send twice, two redact scrub twice, two guards ask twice, and token-weather hides other mods' rows. Re-run with -DisableClashes to turn them off."
  }
  else {
    foreach ($c in $clash) {
      # disabled where it is installed: --scope user fails on a project or local copy
      if (@('user', 'project', 'local') -notcontains $c.scope) { Warn "$($c.id) is installed at $($c.scope) scope, which this script doesn't switch; turn it off in /plugin."; continue }
      $r = Run @('plugin', 'disable', $c.id, '--scope', $c.scope) -Mutates
      if ($r.code -ne 0) { Write-Host $r.out; Fail "could not disable $($c.id)." }
      Write-Host "  disabled $($c.id)"
    }
  }
}

Step 'Done'
Write-Host '  In Claude Code run /reload-plugins (or restart Claude) to load them.'
if ($DryRun) { Write-Host '  This was a dry run: nothing was copied, added, installed, enabled or disabled.' -ForegroundColor Yellow }
