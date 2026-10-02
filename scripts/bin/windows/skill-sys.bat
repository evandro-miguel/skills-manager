@echo off
setlocal
set SCRIPT_DIR=%~dp0
bun "%SCRIPT_DIR%..\..\commands\skill-sys.ts" %*
exit /b %ERRORLEVEL%
