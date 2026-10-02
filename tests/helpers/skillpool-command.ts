type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((value) => (typeof value === 'string' ? value : String(value)))
    .join(' ');
}

function captureCommand(run: () => void): CommandResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode ?? 0;

  let code = 0;

  process.exitCode = 0;
  console.log = (...args: unknown[]) => {
    stdout.push(formatConsoleArgs(args));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(formatConsoleArgs(args));
  };

  try {
    run();
    code = process.exitCode ?? 0;
  } catch (error) {
    code = process.exitCode || 1;
    stderr.push(error instanceof Error ? error.message : String(error));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
  }

  return {
    code,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
  };
}

function okAudit() {
  return { ok: true, message: 'ok' };
}

function okLifecycleAudit() {
  return { ok: true, message: 'ok' };
}

export = {
  captureCommand,
  okAudit,
  okLifecycleAudit,
};
