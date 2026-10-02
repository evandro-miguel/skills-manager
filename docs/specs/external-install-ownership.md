# External Install Ownership

Rule set for coexistence between Universall (`skill-sys`) and external skill
managers (currently the `skills` CLI). Governed by
[ADR-0001](adr-0001-skills-sh-optional-catalog.md).

## Core rule: one manager per target

A skill target directory is administered by exactly one manager at any time.
If two managers rewrite the same target, update/drift/repair cycles fight
each other and silently corrupt installs. Universall therefore never edits a
foreign manager's lockfile and never rewrites targets marked as externally
managed.

## Ownership modes

| Mode | Installs | Updates | Universall behavior |
| --- | --- | --- | --- |
| `skills-owned` | `skills` CLI | `skills` CLI | Audit/read-only |
| `universall-owned` | `skill-sys add` | `skill-sys update` | Full pipeline: pin, digest, scan, project, install, rollback |
| `adopted` | originally `skills` CLI | `skill-sys` after adoption | Ownership transferred only after explicit user approval |

## Ownership state

Universall-owned targets record provenance:

```json
{
  "managedBy": "skill-sys",
  "ownership": {
    "acquiredFrom": "skills-cli",
    "acquiredAt": "2026-08-21T00:00:00Z",
    "sourceLockDigest": "<digest-at-adoption>"
  }
}
```

Before adoption:

```json
{ "managedBy": "external:skills-cli" }
```

## Foreign locks are hints, never proof

The `skills` CLI's lockfiles (`skills-lock.json`, global skill lock) contain
useful source hints but have known inconsistencies across versions (project
vs global flows, migrations dropping entries, name collisions, drift not
detected by update). Universall treats them as leads only: it re-verifies the
filesystem, Git upstream, commit, skill path, and content digest itself.

## Adoption states

Command surfaces `audit-installed` and `adopt-installed` (plan-only) map
every foreign install onto exactly one state:

| State | Meaning |
| --- | --- |
| `MATCHED` | Installed tree matches the resolved upstream source |
| `DRIFTED` | Local modifications or digest mismatch against upstream |
| `SOURCE_MISSING` | Declared source no longer resolves |
| `SOURCE_AMBIGUOUS` | Multiple plausible upstream sources |
| `FOREIGN_SYMLINK` | Symlink escaping the install boundary |
| `NAME_COLLISION` | Name already owned by another managed skill |
| `LOCK_ENTRY_MISSING` | Foreign lock has no entry for the installed path |
| `LOCK_ENTRY_DUPLICATE` | Foreign lock declares conflicting entries for the same name |
| `LOCK_ENTRY_STALE` | Lock entry points at moved/renamed sources |
| `SAFE_TO_ADOPT` | All checks passed; awaiting explicit user approval |

Ownership transfer happens only on an explicit apply step with the recorded
adoption digest. Audit commands are read-only.

## Status

P1 (in progress): the read-only audit engine exists as a library —
`scripts/modules/application/services/installed-skill-adoption.ts`
(classification), `scripts/modules/integrations/skills-cli/lock-reader.ts`
(foreign lock parsing), `scripts/modules/integrations/skills-cli/install-
scanner.ts` (target scanning, symlink escape detection), and
`scripts/modules/integrations/skills-cli/upstream-verifier.ts` (materializes
https `.git` sources pinned by foreign locks into a temporary clone, preferring
the pinned commit over a mutable ref, and digests the declared skill path).
Offline checks cover structural findings (`FOREIGN_SYMLINK`, `NAME_COLLISION`,
`LOCK_ENTRY_MISSING`, `LOCK_ENTRY_STALE`); the upstream verifier adds
`UPSTREAM_MATCH`, `UPSTREAM_DRIFT`, and `SOURCE_MISSING`. The `audit-installed`
CLI command ships with this engine:

```bash
skill-sys audit-installed --manager skills --project . [--global] [--strict] [--json] [--verify-upstream]
```

It prints the JSON report to stdout and a human summary to stderr. Exit codes:
`0` completed, `1` `--strict` with BLOCKED findings, `2` usage or operational
error (when invoked through the `skill-sys` front door, child non-zero exits
surface as front-door failures). Requested scopes whose lock or target is
absent are surfaced in the report (`absentScopes`) and on stderr instead of
being silently skipped; malformed foreign-lock entries surface as
`lockWarnings`. Without `--verify-upstream`, clean installs report
`NEEDS_UPSTREAM_VERIFICATION`; with it, `UPSTREAM_MATCH` plus no structural
findings yields a `SAFE_TO_ADOPT` verdict, so end-to-end verification no
longer depends on caller-supplied digests. `--strict` exits non-zero when
anything is BLOCKED.

### Adoption plan

The plan-only `adopt-installed` command turns verified installs into adoption
actions:

```bash
skill-sys adopt-installed --manager skills --project .
```

It prints the JSON adoption plan to stdout; only `SAFE_TO_ADOPT` findings
become actions. Each action lists the steps a future apply would execute:
declare the source in `skill-sys.sources.json`, pin the resolved commit via
`generate-lock`, and record the ownership receipt
`managedBy=skill-sys acquiredFrom=<manager>`. Ownership transfer (`--apply`)
is intentionally not implemented and exits `2` with the governance message:
"adopt-installed: --apply is not implemented; ownership transfer awaits the
governed ownership-state specification. Plan output only." Running
`audit-installed --verify-upstream` is what makes these `SAFE_TO_ADOPT`
verdicts achievable end-to-end.
