# Windows Onboarding

Use this when setting up a User Skill Root plus optional replicated global core
on Windows. User-local private skills should live in a User Skill Root by default
(`SKILL_SYS_USER_ROOT` or `%USERPROFILE%\.skill-sys`). If the user wants
versioning, that root can be a checkout of any repository the user chooses. The
base/public-engine `universall-skill-sys` repo documents the tooling contract but
does not carry real private global-core skills.

Bun is required for the CLI and Windows launchers. These instructions describe
the intended Windows setup; this candidate has not been tested on native
Windows. Creating a User Skill Root does not install or execute its skills.

## PowerShell user-root setup

```powershell
$env:SKILL_SYS_USER_ROOT = "$env:USERPROFILE\.skill-sys"
New-Item -ItemType Directory -Force "$env:SKILL_SYS_USER_ROOT\skills" | Out-Null
```

## Optional versioned user-root PowerShell setup

```powershell
# Optional: replace the local root with a checkout of the user's chosen repo.
git clone <user-chosen-skill-repo-url> "$env:SKILL_SYS_USER_ROOT"
Set-Location "$env:SKILL_SYS_USER_ROOT"
```

## CMD user-root setup

```bat
set SKILL_SYS_USER_ROOT=%USERPROFILE%\.skill-sys
mkdir %SKILL_SYS_USER_ROOT%\skills
```

## Optional versioned user-root CMD setup

```bat
REM Optional: replace the local root with a checkout of the user's chosen repo.
git clone <user-chosen-skill-repo-url> %SKILL_SYS_USER_ROOT%
cd /d %SKILL_SYS_USER_ROOT%
```

## Optional secure pinned source mode

When installing from any remote skillpack or user-chosen repo, prefer immutable
refs and checksum/provenance verification where the source supports it.

## Result

For User Skill Roots, private skills live under:

- User root: `%USERPROFILE%\.skill-sys\skills\<skill>\SKILL.md`

When a user-chosen source carries a source-root `globals/core.json`, the
replicated global core can be synced to:

- OpenCode: `%USERPROFILE%\.config\opencode\skills`
- Codex: `%USERPROFILE%\.codex\skills`
- Qwen: `%USERPROFILE%\.qwen\skills`
- Gemini CLI: `%USERPROFILE%\.gemini\skills`
- Source clone: user-chosen, e.g. `%SKILL_SYS_USER_ROOT%`
