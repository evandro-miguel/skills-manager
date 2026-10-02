#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { redactArgvForDiagnostics } from "./redact.ts";

type OutputToStringOptions = {
  trim?: boolean;
};

export type RunCommandOptions = {
  cwd?: string;
  stdout?: "inherit" | "pipe";
  stderr?: "inherit" | "pipe";
  env?: Record<string, string | undefined>;
  allowFailure?: boolean;
  trimOutput?: boolean;
  /**
   * Maximum wall-clock time for the child in milliseconds. When exceeded, the
   * child is terminated (SIGTERM) and the outcome is reported deterministically
   * with exit code 124 (the conventional GNU timeout status), both in thrown
   * errors and in results returned under `allowFailure`. Intentionally
   * opt-in: long-running release flows (coverage gates, network clones) are
   * not compatible with a universal finite default.
   */
  timeoutMs?: number;
  /**
   * Per-stream byte cap for captured pipe output (`stdout: "pipe"` /
   * `stderr: "pipe"`). Enforced at spawn time through the runtime's
   * synchronous `maxBuffer`: when a captured stream exceeds the cap the child
   * is terminated during capture instead of being allowed to buffer without
   * bound, and the overflow is mapped deterministically to exit code 125 in
   * both thrown errors and results returned under `allowFailure`.
   * Returned/thrown stream text stays truncated to the cap on UTF-8 character
   * boundaries and visibly marked. Inherited streams are never captured, so
   * the cap applies to captured pipe output only. Defaults to
   * DEFAULT_MAX_PIPE_OUTPUT_BYTES (8 MiB).
   */
  maxPipeOutputBytes?: number;
};

export type RunCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const TIMEOUT_EXIT_CODE = 124;
/**
 * Deterministic exit code reported when a captured stream exceeded
 * maxPipeOutputBytes and the runtime terminated the child. Deliberately
 * distinct from the GNU timeout status (124).
 */
const OVERFLOW_EXIT_CODE = 125;
/**
 * Deterministic exit code for a child terminated by an external signal
 * (conventional shell fatal-signal base). Keeps RunCommandResult.code numeric.
 */
const SIGNAL_EXIT_CODE = 128;
/**
 * Shell-conventional statuses for synchronous spawn pre-execution failures:
 * 127 when the executable could not be found at all, 126 when it was found
 * but could not be executed (permission denied or another pre-exec refusal).
 */
const SPAWN_NOT_FOUND_EXIT_CODE = 127;
const SPAWN_CANNOT_EXECUTE_EXIT_CODE = 126;
/** Linux signal numbers for the deterministic `128 + signo` mapping. */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGIOT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
};
const DEFAULT_MAX_PIPE_OUTPUT_BYTES = 8 * 1024 * 1024;
const TRUNCATION_MARKER_PREFIX = "[runCommand truncated captured output:";
const OVERFLOW_MARKER_PREFIX = "[runCommand captured output exceeded maxPipeOutputBytes=";
const OVERFLOW_MARKER_SUFFIX = " bytes; child terminated]";

function outputToString(
  output: Uint8Array | null | undefined,
  options: OutputToStringOptions = {}
): string {
  const text = output ? Buffer.from(output).toString("utf8") : "";
  return options.trim === false ? text : text.trim();
}

function resolvePositiveIntegerOption(
  value: number | undefined,
  label: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`runCommand ${label} must be a positive integer`);
  }
  return value;
}

/**
 * Largest byte count at or below `limit` that ends on a UTF-8 character
 * boundary. Walks back over continuation bytes (at most 3 for a 4-byte
 * sequence) so decoding never splits a multi-byte character.
 */
function utf8SafeKeptByteCount(bytes: Uint8Array, limit: number): number {
  if (bytes.length <= limit) {
    return bytes.length;
  }
  let kept = limit;
  while (kept > 0 && (bytes[kept]! & 0xc0) === 0x80) {
    kept -= 1;
  }
  return kept;
}

function decodeCapturedOutput(
  output: Uint8Array | null | undefined,
  maxPipeOutputBytes: number,
  trim: boolean | undefined
): string {
  if (!output || output.length === 0) {
    return "";
  }
  if (output.length <= maxPipeOutputBytes) {
    return outputToString(output, trim === undefined ? {} : { trim });
  }
  const kept = utf8SafeKeptByteCount(output, maxPipeOutputBytes);
  const keptText = Buffer.from(output.subarray(0, kept)).toString("utf8");
  const marker = `${TRUNCATION_MARKER_PREFIX} kept ${kept} of ${output.length} bytes]`;
  const combined = keptText.length > 0 ? `${keptText}\n${marker}` : marker;
  return trim === false ? combined : combined.trim();
}

interface SpawnOutcome {
  error: NodeJS.ErrnoException | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array | null;
  stderr: Uint8Array | null;
}

function runSynchronously(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  stdoutMode: "inherit" | "pipe",
  stderrMode: "inherit" | "pipe",
  timeoutMs: number | undefined,
  maxPipeOutputBytes: number
): SpawnOutcome {
  const proc = spawnSync(args[0]!, args.slice(1), {
    cwd,
    env,
    // stdin is never piped; children must not wait on the caller for input.
    stdio: ["ignore", stdoutMode, stderrMode],
    killSignal: "SIGTERM",
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    // Runtime-enforced per-stream memory bound: exceeding it terminates the
    // child during capture instead of buffering without limit.
    maxBuffer: maxPipeOutputBytes,
  });
  return {
    error: proc.error ?? null,
    status: proc.status,
    signal: proc.signal ?? null,
    stdout: proc.stdout ?? null,
    stderr: proc.stderr ?? null,
  };
}

function isTimeoutError(error: NodeJS.ErrnoException | null): boolean {
  return error?.code === "ETIMEDOUT";
}

/**
 * Deterministic `128 + signo` status for a child killed by an external
 * signal; unknown signal names keep the conventional fatal-signal base (128).
 */
function signalExitCode(signal: NodeJS.Signals | null): number {
  const signo = signal ? SIGNAL_NUMBERS[signal] : undefined;
  return typeof signo === "number" ? SIGNAL_EXIT_CODE + signo : SIGNAL_EXIT_CODE;
}

/**
 * Pre-exec spawn failures never ran the child, so they get shell-conventional
 * statuses instead of a fabricated exit status: 127 when the executable was
 * not found, 126 for every other refusal to execute (EACCES, EPERM, ...).
 */
function spawnFailureExitCode(error: NodeJS.ErrnoException): number {
  return error.code === "ENOENT"
    ? SPAWN_NOT_FOUND_EXIT_CODE
    : SPAWN_CANNOT_EXECUTE_EXIT_CODE;
}

/**
 * Sanitized static reason for a pre-exec spawn failure. Only the errno code
 * and this fixed wording enter thrown headers — never runtime error text,
 * which can embed arbitrary paths or environment details.
 */
function spawnFailureReason(error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") {
    return "command not found";
  }
  if (error.code === "EACCES" || error.code === "EPERM") {
    return "permission denied";
  }
  return "failed to spawn";
}

/**
 * Overflow detection over the runtime's own spawn error. Bun reports ENOBUFS;
 * Node >=16 reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER; the message match keeps
 * the mapping deterministic across either spelling.
 */
function isMaxBufferOverflowError(error: NodeJS.ErrnoException | null): boolean {
  if (!error) {
    return false;
  }
  if (error.code === "ENOBUFS" || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return true;
  }
  return /maxBuffer/i.test(String(error.message ?? ""));
}

/**
 * Render one captured stream: bounded to the cap on UTF-8 boundaries and, when
 * the runtime terminated the child on overflow, visibly marked as such.
 */
function renderCapturedStream(
  output: Uint8Array | null | undefined,
  options: {
    piped: boolean;
    overflowed: boolean;
    maxPipeOutputBytes: number;
    trim: boolean | undefined;
  }
): string {
  if (!options.piped) {
    return "";
  }
  const text = decodeCapturedOutput(output, options.maxPipeOutputBytes, options.trim);
  if (!options.overflowed) {
    return text;
  }
  const marker =
    `${OVERFLOW_MARKER_PREFIX}${options.maxPipeOutputBytes}${OVERFLOW_MARKER_SUFFIX}`;
  if (!text) {
    return marker;
  }
  if (text.includes(marker)) {
    return text;
  }
  const combined = `${text}\n${marker}`;
  return options.trim === false ? combined : combined.trim();
}

export function runCommand(args: string[], options: RunCommandOptions = {}): RunCommandResult {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("runCommand requires a non-empty argument array");
  }

  const timeoutMs = resolvePositiveIntegerOption(options.timeoutMs, "timeoutMs");
  const maxPipeOutputBytes =
    resolvePositiveIntegerOption(options.maxPipeOutputBytes, "maxPipeOutputBytes") ??
    DEFAULT_MAX_PIPE_OUTPUT_BYTES;

  const stdoutMode = options.stdout || "inherit";
  const stderrMode = options.stderr || "inherit";

  const outcome = runSynchronously(
    args,
    options.cwd || process.cwd(),
    options.env || process.env,
    stdoutMode,
    stderrMode,
    timeoutMs,
    maxPipeOutputBytes
  );

  const timedOut = isTimeoutError(outcome.error);
  const overflowed = !timedOut && isMaxBufferOverflowError(outcome.error);
  // Pre-exec spawn failures (ENOENT/EACCES/...) are distinct from timeout and
  // overflow and never carry a child exit status.
  const spawnFailure = !timedOut && !overflowed ? outcome.error : null;

  // Deterministic mappings: a timed-out child reports 124 (GNU convention), an
  // overflow-killed child reports 125, an unspawnable command reports the
  // shell-conventional 127/126, and an externally signalled child reports
  // 128 + signal number — regardless of any partial exit state.
  const exitCode = timedOut
    ? TIMEOUT_EXIT_CODE
    : overflowed
      ? OVERFLOW_EXIT_CODE
      : spawnFailure
        ? spawnFailureExitCode(spawnFailure)
        : outcome.status ?? signalExitCode(outcome.signal);

  const stdout = renderCapturedStream(outcome.stdout, {
    piped: stdoutMode === "pipe",
    overflowed,
    maxPipeOutputBytes,
    trim: options.trimOutput,
  });
  const stderr = renderCapturedStream(outcome.stderr, {
    piped: stderrMode === "pipe",
    overflowed,
    maxPipeOutputBytes,
    trim: options.trimOutput,
  });

  if (exitCode !== 0 && !options.allowFailure) {
    // Captured child output is intentionally excluded from thrown errors:
    // arbitrary child output can carry secrets, so failures surface only the
    // redacted argv plus a deterministic termination reason. Spawn failures
    // add only the errno code and a static reason; the original error rides
    // along as `cause` for programmatic diagnosis without entering headers.
    const rendered = [
      `Command failed (${exitCode}): ${redactArgvForDiagnostics(args).join(" ")}`,
      timedOut ? `command exceeded timeoutMs=${timeoutMs}ms and was terminated` : "",
      overflowed
        ? `captured output exceeded maxPipeOutputBytes=${maxPipeOutputBytes} bytes and the child was terminated`
        : "",
      spawnFailure
        ? `spawn failed (${String(spawnFailure.code ?? "unknown")}): ${spawnFailureReason(spawnFailure)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    throw new Error(
      rendered,
      spawnFailure ? { cause: spawnFailure } : undefined
    );
  }

  return { code: exitCode, stdout, stderr };
}
