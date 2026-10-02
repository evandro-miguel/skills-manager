# Uninstall and Rollback Spec

PR10 ships a deterministic remove planner plus a destructive apply mode that is
rollback-compatible. The planner proves which skill-sys-managed files would be
removed; apply runs the same planner, creates backups, then mutates and writes
state last.

## Current scope: remove planner and apply

```bash
skill-sys remove --project <dir> --skill <name> --plan [--app <app>] [--json]
skill-sys remove --project <dir> --all --dry-run [--app <app>] [--json]
skill-sys remove --project <dir> --skill <name> --apply [--app <app>] [--force] [--json]
skill-sys remove --project <dir> --all --apply --confirm-all [--app <app>] [--force] [--json]
```

The planner reads `<project>/.skills.state.json` and selects only entries whose
`managedBy` field is `skill-sys`. The planner path does not delete, rename,
move, or write any project file. Apply runs the planner first, then performs
the mutations described below.

## Fail-closed rules

- `--project` is required.
- One of `--plan`, `--dry-run`, or `--apply` is required.
- `--apply` cannot be combined with `--plan` or `--dry-run`.
- Removing without `--skill` is broad removal and requires explicit `--all`;
  broad apply additionally requires `--confirm-all`.
- `--skill` and `--all` are mutually exclusive.
- The project cannot be the user's HOME directory.
- Targets must be project-relative paths resolving inside the project.
- Symlink targets and symlink path components are refused.
- Unmanaged entries are ignored.

## Plan output

The planner returns deterministic actions sorted by app, skill, then target. Each
action includes:

- `app`
- `skill`
- `target`
- `installMode`
- `exists`
- `recordedDigest`
- `actualDigest`
- `digestMatches`

When a stored digest exists, the planner recomputes the live directory digest and
reports drift with `digestMatches: false`. Missing targets also report digest
mismatch when a digest was recorded.

## Apply behavior

`skill-sys remove --apply` reuses the planner output and then:

1. Fails closed before any mutation when a recorded digest is missing from disk
   or the live digest drifts from the recorded digest, unless `--force` is
   passed.
2. Creates a rollback-compatible backup before deleting any present target.
   Backups live under `<targetParent>/.skill-sys-backup/<removeId>/<skillName>/`
   and use the same `ISO-pid-rand` remove id scheme as install.
3. Writes `remove-ledger.json` in each backup root containing only the state
   entries whose target lives under that root, then writes `.complete`.
4. Deletes present targets one at a time, recomputing the live directory digest
   immediately before each `rm`. Any TOCTOU drift from the planner digest aborts
   even when `--force` is passed.
5. Rewrites `.skills.state.json` atomically last, dropping only the managed
   entries selected by the plan.

An empty plan is a no-op and creates no backup.

## Rollback relationship

Rollback remains the recovery path for both completed installs and remove apply
records. It restores from `.skill-sys-backup/<id>` and reconciles
`.skills.state.json`. For remove backups, rollback ignores `remove-ledger.json`
as a restore directory, restores the backed-up skill directories, and merges
ledger entries back into `.skills.state.json` for targets that are not already
present.
