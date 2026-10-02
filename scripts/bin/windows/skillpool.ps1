#!/usr/bin/env pwsh
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $ScriptDir "..\..\commands\skillpool.ts"
& bun $Script @Args
exit $LASTEXITCODE
