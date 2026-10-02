@echo off
setlocal
set SCRIPT_DIR=%~dp0
bun "%SCRIPT_DIR%..\..\commands\install-skills.ts" %*
exit /b %ERRORLEVEL%
