import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../scripts/lib/command.ts";

const BUN = process.execPath;

type RunOptions = Parameters<typeof runCommand>[1];

function captureError(args: string[], options?: RunOptions): Error {
  try {
    runCommand(args, options);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`expected runCommand to throw for: ${args.join(" ")}`);
}

const FAIL_FAST = [BUN, "-e", "process.exit(3)"];
const SLEEPER = [BUN, "-e", "setTimeout(() => {}, 30000);"];
const SECTIONS_CHILD = [
  BUN,
  "-e",
  "console.log('out-line'); console.error('err-line'); process.exit(1);",
];
const FLOOD_STDOUT_SCRIPT = 'process.stdout.write("x".repeat(100000));';
const MULTIBYTE_SCRIPT = 'process.stdout.write("\\u03b1\\u03b2\\u03b3\\u{1f600}".repeat(4000));';

describe("runCommand hardening", () => {
  test("ordinary failures keep the frozen Command failed header and exclude captured output", () => {
    expect(captureError(FAIL_FAST).message).toBe(
      `Command failed (3): ${FAIL_FAST.join(" ")}`,
    );

    // Captured child output never enters thrown errors: arbitrary child output
    // can carry secrets, so failures stay header-only by default.
    const sections = captureError(SECTIONS_CHILD, { stdout: "pipe", stderr: "pipe" });
    expect(sections.message).toBe(
      `Command failed (1): ${SECTIONS_CHILD.join(" ")}`,
    );
  });

  test("a failing child printing a secret does not leak it into the thrown error", () => {
    // The full secret never appears in argv either; the child composes it.
    const args = [
      BUN,
      "-e",
      `const s = "child-emitted-" + "secret-do-not-leak"; console.error('token=' + s); process.exit(1);`,
    ];
    const error = captureError(args, { stdout: "pipe", stderr: "pipe" });

    expect(error.message).toBe(`Command failed (1): ${args.join(" ")}`);
    expect(error.message).not.toContain("child-emitted-secret-do-not-leak");
  });

  test("empty argv validation error is unchanged", () => {
    expect(() => runCommand([])).toThrow("runCommand requires a non-empty argument array");
  });

  test("allowFailure, exit-code passthrough, and trimOutput:false are preserved", () => {
    const padded = [BUN, "-e", 'process.stdout.write("  padded  ");'];
    const kept = runCommand(padded, { stdout: "pipe", trimOutput: false });
    expect(kept.code).toBe(0);
    expect(kept.stdout).toBe("  padded  ");

    const allowed = runCommand([BUN, "-e", "process.exit(5)"], {
      allowFailure: true,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(allowed.code).toBe(5);

    const failing = captureError([BUN, "-e", "process.exit(5)"], {});
    expect(failing.message).toBe(`Command failed (5): ${BUN} -e process.exit(5)`);
  });

  test("bounded timeout terminates runaway commands deterministically with code 124", () => {
    const startedAt = Date.now();
    const error = captureError(SLEEPER, { timeoutMs: 250 });
    const elapsed = Date.now() - startedAt;

    expect(error.message.startsWith("Command failed (124): ")).toBe(true);
    expect(error.message).toContain(
      `command exceeded timeoutMs=250ms and was terminated`,
    );
    expect(elapsed).toBeLessThan(15000);

    const allowed = runCommand(SLEEPER, { timeoutMs: 250, allowFailure: true });
    expect(allowed.code).toBe(124);

    const fast = runCommand([BUN, "-e", "console.log('ok')"], {
      timeoutMs: 30000,
      stdout: "pipe",
    });
    expect(fast.code).toBe(0);
    expect(fast.stdout).toBe("ok");
  });

  test("invalid timeout and cap options are rejected deterministically", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => runCommand(FAIL_FAST, { timeoutMs: bad })).toThrow(
        "runCommand timeoutMs must be a positive integer",
      );
      expect(() => runCommand(FAIL_FAST, { maxPipeOutputBytes: bad })).toThrow(
        "runCommand maxPipeOutputBytes must be a positive integer",
      );
    }
  });

  test("spawn-time cap terminates a flooding child and maps overflow to exit code 125", () => {
    const startedAt = Date.now();
    const result = runCommand([BUN, "-e", FLOOD_STDOUT_SCRIPT], {
      stdout: "pipe",
      maxPipeOutputBytes: 8192,
      allowFailure: true,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.code).toBe(125);
    expect(result.stdout).toContain(
      "[runCommand captured output exceeded maxPipeOutputBytes=8192 bytes; child terminated]",
    );
    expect(result.stdout.length).toBeLessThan(8192 + 200);
    expect(elapsed).toBeLessThan(15000);
  });

  test("overflow truncation keeps output bounded for multibyte floods", () => {
    const result = runCommand([BUN, "-e", MULTIBYTE_SCRIPT], {
      stdout: "pipe",
      maxPipeOutputBytes: 8192,
      allowFailure: true,
    });

    expect(result.code).toBe(125);
    // Leading multi-byte characters survive any bounded decode path.
    expect(result.stdout.startsWith("αβγ")).toBe(true);
    expect(
      result.stdout.includes("[runCommand captured output exceeded maxPipeOutputBytes=8192 bytes; child terminated]") ||
        result.stdout.includes("[runCommand truncated captured output:"),
    ).toBe(true);
    expect(result.stdout.length).toBeLessThan(8192 + 300);
  });

  test("both captured pipes stay bounded when stdout and stderr flood", () => {
    const floodBoth = [
      BUN,
      "-e",
      'process.stdout.write("s".repeat(50000)); process.stderr.write("e".repeat(50000)); process.exit(7);',
    ];
    const result = runCommand(floodBoth, {
      stdout: "pipe",
      stderr: "pipe",
      allowFailure: true,
      maxPipeOutputBytes: 4096,
    });

    expect(result.code).toBe(125);
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).toContain(
        "[runCommand captured output exceeded maxPipeOutputBytes=4096 bytes; child terminated]",
      );
      expect(stream.length).toBeLessThan(4096 + 200);
    }
  });

  test("thrown overflow errors are deterministic, header-only, and leak no child bytes", () => {
    const floodFail = [
      BUN,
      "-e",
      'process.stderr.write("z".repeat(199000)); process.stdout.write("TAIL".concat("-END")); process.exit(1);',
    ];
    const error = captureError(floodFail, { stdout: "pipe", stderr: "pipe", maxPipeOutputBytes: 2048 });

    expect(error.message).toBe(
      `Command failed (125): ${floodFail.join(" ")}\n\ncaptured output exceeded maxPipeOutputBytes=2048 bytes and the child was terminated`,
    );
    expect(error.message.length).toBeLessThan(4096);
    expect(error.message.includes("TAIL-END")).toBe(false);
    expect(error.message.includes("zzzzz")).toBe(false);
  });

  test("default per-stream cap is finite (8 MiB) and enforced at spawn time", () => {
    const total = 9 * 1024 * 1024;
    const startedAt = Date.now();
    const result = runCommand([BUN, "-e", `process.stdout.write("y".repeat(${total}));`], {
      stdout: "pipe",
      allowFailure: true,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.code).toBe(125);
    expect(result.stdout).toContain("[runCommand captured output exceeded maxPipeOutputBytes=");
    expect(result.stdout).toContain("child terminated]");
    expect(result.stdout.length).toBeLessThan(8 * 1024 * 1024 + 200);
    expect(elapsed).toBeLessThan(15000);
  });

  test("inherited streams are not captured; the cap documents captured pipe output only", () => {
    const result = runCommand([BUN, "-e", 'console.log("inherit-noise");'], {
      stdout: "inherit",
      stderr: "inherit",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("secret-bearing --flag value argv is redacted in thrown errors only", () => {
    const secret = "fixture-token-value-do-not-leak";
    const args = [BUN, "-e", "console.error('boom'); process.exit(1);", "--token", secret];
    const error = captureError(args, { stdout: "pipe" });

    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("--token [REDACTED]");

    // The spawned child still receives the real argv.
    const echoed = runCommand(
      [BUN, "-e", "console.log(JSON.stringify(process.argv));", "--token", secret],
      { stdout: "pipe", allowFailure: true },
    );
    expect(echoed.code).toBe(0);
    expect(echoed.stdout).toContain(secret);
  });

  test("secret-bearing --password=value argv is redacted in thrown errors only", () => {
    const secret = "fixture-password-value-do-not-leak";
    const args = [BUN, "-e", "process.exit(1);", `--password=${secret}`];
    const error = captureError(args, {});

    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("--password=[REDACTED]");
  });

  test("secret-ish ENV=value argv elements are redacted in thrown errors only", () => {
    const secret = "fixture-env-value-do-not-leak";
    const args = [BUN, "-e", "process.exit(1);", `MY_SERVICE_TOKEN=${secret}`];
    const error = captureError(args, {});

    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("MY_SERVICE_TOKEN=[REDACTED]");
  });

  test("credential-bearing remote argv is redacted in thrown errors", () => {
    const secret = "fixture-remote-secret-do-not-leak";
    for (const remote of [
      `https://user:${secret}@example.com/repo.git`,
      `https://example.com/repo.git?access_token=${secret}`,
    ]) {
      const error = captureError([BUN, "-e", "process.exit(1);", remote], {});
      expect(error.message).not.toContain(secret);
      expect(error.message).toContain("[REDACTED]");
    }
  });

  test("normal argv stays byte-identical in thrown errors", () => {
    const normal = [
      BUN,
      "-e",
      "process.exit(1);",
      "--config",
      "/tmp/settings.json",
      "--json",
      "LOG_LEVEL=debug",
      "--source-entry",
      "/tmp/src",
    ];
    const error = captureError(normal, {});

    expect(error.message).toBe(`Command failed (1): ${normal.join(" ")}`);
  });

  test("a trailing secret flag without a value leaks nothing extra", () => {
    const args = [BUN, "-e", "process.exit(1);", "--api-key"];
    const error = captureError(args, {});

    expect(error.message).toBe(`Command failed (1): ${args.join(" ")}`);
  });

  test("a nonexistent command maps deterministically to 127 with a sanitized reason and the original error as cause", () => {
    const args = ["/nonexistent-skill-sys-command-under-test"];
    const error = captureError(args, {}) as Error & { cause?: NodeJS.ErrnoException };

    expect(error.message.startsWith(`Command failed (127): ${args[0]}`)).toBe(true);
    expect(error.message).toContain("spawn failed (ENOENT): command not found");
    // Runtime spawn-error text (which can embed arbitrary paths) stays out of
    // the thrown header; the original error rides along as `cause`.
    expect(error.message).not.toContain("posix_spawn");
    expect((error.cause as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");

    const allowed = runCommand(args, { allowFailure: true });
    expect(allowed.code).toBe(127);
  });

  test("a non-executable command maps deterministically to 126 under allowFailure and when thrown", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-command-eacces-"));
    try {
      const script = path.join(dir, "not-executable.js");
      fs.writeFileSync(script, "console.log('must not run');\n", "utf8");
      fs.chmodSync(script, 0o644);

      const error = captureError([script], {}) as Error & { cause?: NodeJS.ErrnoException };
      expect(error.message.startsWith("Command failed (126): ")).toBe(true);
      expect(error.message).toContain("spawn failed (EACCES): permission denied");
      expect((error.cause as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");

      const allowed = runCommand([script], { allowFailure: true });
      expect(allowed.code).toBe(126);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a child killed by SIGKILL reports the deterministic 128+9=137 status", () => {
    const sigkillChild = [BUN, "-e", 'process.kill(process.pid, "SIGKILL");'];

    const error = captureError(sigkillChild, {});
    expect(error.message.startsWith("Command failed (137): ")).toBe(true);

    const allowed = runCommand(sigkillChild, { allowFailure: true });
    expect(allowed.code).toBe(137);
  });
});
