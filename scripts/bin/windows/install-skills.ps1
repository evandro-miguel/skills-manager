#!/usr/bin/env pwsh
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $ScriptDir "..\..\commands\install-skills.ts"
& bun $Script @Args
exit $LASTEXITCODE
