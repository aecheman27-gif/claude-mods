<#
.SYNOPSIS
  Builds the work bundle zip from the committed state (HEAD) of this repo: each
  mod's manifest, hooks, types, tests, skills, sounds and licences, without
  docs, demo media, websites or CI files. reflect-mod is left out.
  Uncommitted edits are NOT included; commit first.
.EXAMPLE
  .\work-bundle\build-zip.ps1 -Out "$HOME\Desktop\claude-mods-work.zip"
#>
param([string]$Out = (Join-Path ([Environment]::GetFolderPath('Desktop')) "claude-mods-work-$(Get-Date -Format yyyyMMdd).zip"))

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$skip = '^(reflect-mod/|[^/]+/(docs|site|media|screenshots|tools|scripts|\.github|\.githooks|\.claude)/)|\.(gif|png|mp4|woff2?|svg)$'

$dirty = git -C $repo status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
if ($dirty) { Write-Host "Note: uncommitted changes are left out of the zip:`n$($dirty -join "`n")" -ForegroundColor Yellow }

$tmp = Join-Path ([IO.Path]::GetTempPath()) "claude-mods-work-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$stage = Join-Path $tmp 'stage'
New-Item -ItemType Directory $stage | Out-Null
git -C $repo archive --format=zip -o (Join-Path $tmp 'head.zip') HEAD
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
Expand-Archive (Join-Path $tmp 'head.zip') -DestinationPath $stage
$kept = 0
$files = @(git -C $repo ls-tree -r --name-only HEAD)
if ($LASTEXITCODE -ne 0) { throw 'git ls-tree failed' }   # an empty list would ship reflect-mod, docs and media
foreach ($f in $files) {
  if ($f -match $skip) { Remove-Item -LiteralPath (Join-Path $stage $f) } else { $kept++ }
}
Get-ChildItem $stage -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending |
  Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } | Remove-Item

# reflect-mod stays listed in the marketplace at home; the bundle's copy drops it
$mp = Join-Path $stage '.claude-plugin\marketplace.json'
$json = [IO.File]::ReadAllText($mp) | ConvertFrom-Json
$json.plugins = @($json.plugins | Where-Object { $_.name -ne 'reflect-mod' })
[IO.File]::WriteAllText($mp, ($json | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false)) # no BOM, on 5.1 too

if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $Out
$commit = git -C $repo rev-parse --short HEAD
if ($LASTEXITCODE -ne 0) { throw 'git rev-parse failed' }
Write-Host "Built $Out from commit ${commit}: $kept files, $([math]::Round((Get-Item -LiteralPath $Out).Length / 1KB)) KB"
Write-Host "Staging copy: $stage"
