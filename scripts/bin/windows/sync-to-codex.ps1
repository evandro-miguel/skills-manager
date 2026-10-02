#!/usr/bin/env pwsh
$RepoDir = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$CodexSkills = if ($env:CODEX_SKILLS_DIR) { $env:CODEX_SKILLS_DIR } else { Join-Path $HOME ".codex/skills" }

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Error "bun is required but was not found in PATH"
  exit 1
}

git -C $RepoDir pull --ff-only
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($env:VERIFY_SIGNED_TAG -eq "1") {
  if (-not $env:RELEASE_REF) {
    Write-Error "set RELEASE_REF when VERIFY_SIGNED_TAG=1"
    exit 1
  }
  git -C $RepoDir tag -v $env:RELEASE_REF
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($env:EXPECTED_SOURCE_SHA256) {
  $actual = (bun (Join-Path $RepoDir "scripts/commands/source-checksum.ts") --source $RepoDir).Trim().ToLowerInvariant()
  $expected = $env:EXPECTED_SOURCE_SHA256.Trim().ToLowerInvariant()
  if ($actual -ne $expected) {
    Write-Error "source checksum mismatch expected=$expected actual=$actual"
    exit 1
  }
}

bun (Join-Path $RepoDir "scripts/commands/universal-contract.ts") --skills-root (Join-Path $RepoDir "skills")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$env:CODEX_SKILLS_DIR = $CodexSkills
bun (Join-Path $RepoDir "scripts/commands/sync-global-core.ts") --source $RepoDir --apps codex --no-contract-check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done: synced global core to $CodexSkills"
