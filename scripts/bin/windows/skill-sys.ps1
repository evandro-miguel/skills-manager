#!/usr/bin/env pwsh
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $ScriptDir "..\..\commands\skill-sys.ts"
& bun $Script @Args
exit $LASTEXITCODE
