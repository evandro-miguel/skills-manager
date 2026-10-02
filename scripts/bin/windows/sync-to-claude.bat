@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "REPO_DIR=%~dp0..\..\.."

if "%CLAUDE_SKILLS_DIR%"=="" set "CLAUDE_SKILLS_DIR=%USERPROFILE%\.claude\skills"

where bun >nul 2>nul
if errorlevel 1 (
  echo ERROR: bun is required but was not found in PATH 1>&2
  exit /b 1
)

git -C "%REPO_DIR%" pull --ff-only
if errorlevel 1 exit /b %ERRORLEVEL%

if "%VERIFY_SIGNED_TAG%"=="1" (
  if "%RELEASE_REF%"=="" (
    echo ERROR: set RELEASE_REF when VERIFY_SIGNED_TAG=1 1>&2
    exit /b 1
  )
  git -C "%REPO_DIR%" tag -v "%RELEASE_REF%"
  if errorlevel 1 exit /b %ERRORLEVEL%
)

if not "%EXPECTED_SOURCE_SHA256%"=="" (
  for /f "usebackq delims=" %%i in (`bun "%REPO_DIR%\scripts\commands\source-checksum.ts" --source "%REPO_DIR%"`) do set "ACTUAL_SHA=%%i"
  if /I not "!ACTUAL_SHA!"=="%EXPECTED_SOURCE_SHA256%" (
    echo ERROR: source checksum mismatch expected=%EXPECTED_SOURCE_SHA256% actual=!ACTUAL_SHA! 1>&2
    exit /b 1
  )
)

bun "%REPO_DIR%\scripts\commands\universal-contract.ts" --skills-root "%REPO_DIR%\skills"
if errorlevel 1 exit /b %ERRORLEVEL%

set "CLAUDE_SKILLS_DIR=%CLAUDE_SKILLS_DIR%"
bun "%REPO_DIR%\scripts\commands\sync-global-core.ts" --source "%REPO_DIR%" --apps claude-code --no-contract-check
if errorlevel 1 exit /b %ERRORLEVEL%

echo Done: synced global core to %CLAUDE_SKILLS_DIR%
