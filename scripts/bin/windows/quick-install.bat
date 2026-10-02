@echo off
setlocal
set SCRIPT_DIR=%~dp0
bun "%SCRIPT_DIR%..\..\commands\quick-install.ts" %*
exit /b %ERRORLEVEL%
