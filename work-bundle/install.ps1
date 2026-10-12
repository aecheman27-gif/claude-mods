<#
.SYNOPSIS
  Installs the my-claude-mods marketplace into Claude Code (user scope).

.DESCRIPTION
  1. Copies this bundle to -Dest (default: $HOME\src\claude-mods).
  2. Validates the marketplace and every mod with `claude plugin validate`.
  3. Runs each mod's tests with `claude plugin test` (skip with -SkipTests).
     A failure in one of this marketplace's own mods stops the install; a failure in a
     vendored mod (its upstream tests) is reported as a warning.
  4. Adds the "my-claude-mods" marketplace (or refreshes it when it already
     points at -Dest) and installs the mods, then disables any in -Disable.
  5. Lists other copies of the same mods from other marketplaces (blast-radius,
     replay-theater, token-weather, ...) and disables them only with -DisableClashes.
  Stops at the first failure. Works in Windows PowerShell 5.1 and PowerShell 7.

.EXAMPLE
  .\install.ps1 -DryRun                      # validate and test, change nothing
  .\install.ps1                              # do it
  .\install.ps1 -Exclude cc-arcade -Disable savvy-progress
  .\install.ps1 -Exclude "cc-arcade,hw-write-guard" -DisableClashes
#>
[CmdletBinding()]
param(
  [string]$Dest = (Join-Path $HOME 'src\claude-mods'),
  [string[]]$Exclude = @(),
  [string[]]$Disable = @(),
  [switch]$SkipTests,
  [switch]$DisableClashes,
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path   # the bundle root holds .claude-plugin\marketplace.json
$Dest = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dest)
$Market = 'my-claude-mods'
$Tested = '2.1.295'
$Clashing = @('blast-radius', 'replay-theater', 'token-weather', 'control-panel', 'context-meter')
# `-Exclude a,b` through `powershell -File` arrives as one string: split it
$split = { param($list) @($list | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$Exclude = @(& $split $Exclude) + 'reflect-mod'
$Disable = @(& $split $Disable)

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Warn($text) { Write-Host "  WARNING: $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "STOPPED: $text" -ForegroundColor Red; exit 1 }
function Run([string[]]$argv, [switch]$Mutates) {
  if ($DryRun -and $Mutates) { Write-Host "  [dry run] claude $($argv -join ' ')" -ForegroundColor DarkGray; return @{ code = 0; out = '' } }
  $ErrorActionPreference = 'Continue'   # 5.1 turns a native command's stderr into an error record under 'Stop'
  $out = & claude @argv 2>&1 | ForEach-Object { "$_" } | Out-String
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
$version = ((Run @('--version')).out.Trim() -split ' ')[0]
Write-Host "  claude $version (this bundle was built and tested on $Tested)"
if ($version -ne $Tested) { Warn 'different version: the validate and test steps below are what tell whether the mods still fit.' }

Step "Copy to $Dest"
if (-not (Test-Path -LiteralPath (Join-Path $Source '.claude-plugin\marketplace.json'))) { Fail "no marketplace.json under $Source; run this script from the unzipped bundle's work-bundle folder." }
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

$all = (Get-Content -LiteralPath (Join-Path $Root '.claude-plugin\marketplace.json') -Raw -Encoding UTF8 | ConvertFrom-Json).plugins
$unknown = @($Exclude + $Disable | Where-Object { $_ -ne 'reflect-mod' -and ($all.name -notcontains $_) })
if ($unknown) { Fail "no mod named: $($unknown -join ', ')" }
$mods = @($all | Where-Object { $Exclude -notcontains $_.name })
Write-Host "  mods: $(($mods | ForEach-Object name) -join ', ')"

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
    Fail "$($m.name) tests failed. Fix it, or re-run with -Exclude $($m.name)."
  }
}

Step "Marketplace $Market"
$known = @(Json @('plugin', 'marketplace', 'list', '--json')) | Where-Object { $_.name -eq $Market }
if ($known) {
  $at = if ($known.path) { $known.path } else { $known.installLocation }
  if (-not (SamePath $at $Root) -and -not $DryRun) { Fail "$Market is already registered at $at, not $Root. Remove it first: claude plugin marketplace remove $Market" }
  if (-not (SamePath $at $Root)) { Warn "$Market is registered at $at; a real run copies to $Dest, which must match it." }
  $r = Run @('plugin', 'marketplace', 'update', $Market) -Mutates
} else {
  $r = Run @('plugin', 'marketplace', 'add', $Root) -Mutates
}
if ($r.code -ne 0) { Write-Host $r.out; Fail 'could not add or update the marketplace.' }
Write-Host '  ready'

Step 'Install'
foreach ($m in $mods) {
  $r = Run @('plugin', 'install', "$($m.name)@$Market", '--scope', 'user') -Mutates
  if ($r.code -ne 0 -and $r.out -notmatch 'already installed') { Write-Host $r.out; Fail "install of $($m.name) failed." }
  Write-Host "  ok  $($m.name)"
}
foreach ($name in $Disable) {
  $r = Run @('plugin', 'disable', "$name@$Market", '--scope', 'user') -Mutates
  if ($r.code -ne 0) { Write-Host $r.out; Fail "could not disable $name." }
  Write-Host "  disabled $name"
}

Step 'Other copies of these mods'
$clash = @(Json @('plugin', 'list', '--json') | Where-Object {
    $_.enabled -and ($_.id -split '@')[1] -ne $Market -and $Clashing -contains ($_.id -split '@')[0]
  } | ForEach-Object { $_.id })
if (-not $clash) { Write-Host '  none enabled' }
elseif (-not $DisableClashes) {
  Warn "enabled copies from other marketplaces: $($clash -join ', '). Two copies of a guard hold twice, and token-weather hides other mods' rows. Re-run with -DisableClashes to turn them off."
}
else {
  foreach ($id in $clash) {
    $r = Run @('plugin', 'disable', $id, '--scope', 'user') -Mutates
    if ($r.code -ne 0) { Write-Host $r.out; Fail "could not disable $id." }
    Write-Host "  disabled $id"
  }
}

Step 'Done'
Write-Host '  In Claude Code run /reload-plugins (or restart Claude) to load them.'
if ($DryRun) { Write-Host '  This was a dry run: nothing was copied, added, installed or disabled.' -ForegroundColor Yellow }
