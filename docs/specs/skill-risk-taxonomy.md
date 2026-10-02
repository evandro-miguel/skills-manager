# Skill Risk Taxonomy

Skill risk metadata lives in `skill.meta.json` and is modeled by
`schema/skill-meta.schema.json`. Security scan v2 uses the same vocabulary when
checking whether observed source markers match declared risk.

## Risk flags

- `readsFiles`: skill reads files from the project or local filesystem.
- `writesProject`: skill writes inside the project.
- `writesGlobal`: skill writes global/shared agent state.
- `executesShell`: skill instructs the agent to execute shell commands or ships
  runnable setup scripts.
- `networkAccess`: skill uses network access or exfiltration-capable commands.
- `externalDirectory`: skill accesses directories outside the selected project or
  skillpack source.
- `credentialSensitive`: skill touches credentials, tokens, auth state, browser
  state, SSH material, or cloud credential stores.
- `destructive`: skill can delete, overwrite, reset, or irreversibly mutate data.
- `browserAuthState`: skill uses browser/profile auth state.
- `repoMutation`: skill can mutate Git state, commits, branches, remotes, or PRs.

## Scanner mapping

Security scan v2 currently checks these declaration classes:

- shell/setup markers imply `executesShell` should be true;
- network markers imply `networkAccess` should be true;
- credential markers imply `credentialSensitive` should be true.

A mismatch is reported as `METADATA_INCONSISTENCY`. This is intentionally
conservative: the scanner reports evidence and does not auto-edit metadata.

When a skill directory has no `skill.meta.json`, the scanner reports
`SKILL_META_MISSING` (ERROR, rule `META_FILE_REQUIRED`) instead of checking
markers against a permissive default. This is distinct from
`METADATA_INCONSISTENCY`, which fires only when declared risk is false despite
observed markers.

## Manual review

Risk flags are advisory metadata for humans and gates. They are not a sandbox
and do not replace source review, sensitive scanning, privacy scanning, or future
runtime sandbox verification.
