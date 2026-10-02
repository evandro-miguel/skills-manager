# Runtime Sandbox Verification Spec

PR13 defines a plan-only runtime sandbox verification contract. This slice does
not execute Docker, containers, skills, scripts, or network calls. It emits the
command vector and self-verifying controls that a future runtime runner must use.

## Command

```bash
skill-sys verify-sandbox --source <dir> --plan|--dry-run [--json]
```

Optional extra mounts use repeatable `--mount <host-source>:<container-target>`.
They are read-only and restricted to `/skill`, `/workspace`, or `/data` targets.

## Safety contract

- `--source` is explicit; there is no HOME/global fallback.
- One of `--plan` or `--dry-run` is required.
- `--apply`, `--run`, and `--execute` fail closed.
- The command never invokes Docker or any child process in this slice.
- Source and extra mount paths must exist, must not be symlinks, and must not
  traverse symlink path components.
- HOME root, SSH/AWS/cloud config, browser auth state, env files, and
  credential-like files are denied as sources or extra mounts.
- Container targets cannot mount over sensitive roots such as `/root`, `/home`,
  `/etc`, `/proc`, `/sys`, `/dev`, or `/var`.

## Required sandbox controls

The emitted verdict re-derives these controls from the planned command vector:

- `networkNone`: `--network none`
- `readonlyFilesystem`: `--read-only`
- `noNewPrivileges`: `--security-opt no-new-privileges`
- `capDropAll`: `--cap-drop ALL`
- `mountsExplicit`: bind mounts are explicit and source-allowlisted
- `denySensitivePaths`: bind sources do not resolve to denied host paths

A missing control yields a blocking violation and `status: BLOCKED`.

## Verdict shape

The machine-readable verdict conforms to `schema/sandbox-verdict.schema.json` and
contains:

- `schemaVersion`
- `command: "verify-sandbox"`
- `status: "PLAN" | "BLOCKED"`
- `mode: "plan" | "dry-run"`
- `source`
- `applySupported: false`
- `runtime.command` and `runtime.args`
- `controls`
- `mounts`
- `violations`

## Deferred work

Actual container execution, runtime capture, and source trust policy are future
work. Any future execution mode must preserve this fail-closed control contract
and must pass security scan v2 before running script-enabled skills.
