@echo off
setlocal
set SCRIPT_DIR=%~dp0
bun "%SCRIPT_DIR%..\..\commands\publish-skill.ts" %*
exit /b %ERRORLEVEL%
