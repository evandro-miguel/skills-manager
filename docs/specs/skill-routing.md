# Skill Routing Spec

Status: PR17 first offline MVP.

Routing rules map a user intent string to candidate skills using deterministic
local JSON rules. The PR17 MVP is a validator and read-only router only: it never
loads skills into an agent, executes skills, calls LLMs, opens the network, uses
tools, or writes outputs.

## Command

```bash
skill-sys route --source <dir> --rules <file> --query <text> [--json] [--strict] [--execute --adapter local-test]
```

- `--source` points at a skill source with `skills/<name>/SKILL.md` entries.
- `--rules` points at a routing-rules JSON file.
- `--query` is the intent text to match.
- `--json` emits `schema/route-result.schema.json` output.
- `--strict` treats warnings as blocking.
- `--execute --adapter local-test` is an explicit in-process fixture seam after
  a passing route result. It receives at most 32 validated candidates (rule,
  skill, score, and `manualOnly`) and receives no query, paths, or trigger
  text. It never activates a skill. Unsupported adapters, empty sets, invalid
  or non-deterministic responses, outside candidates, and `manualOnly`
  selection block fail-closed.

## Rules Schema

Routing files use `schema/routing-rules.schema.json`.

```json
{
  "schemaVersion": 1,
  "name": "default",
  "rules": [
    {
      "id": "docs",
      "skill": "docs-skill",
      "triggers": ["docs", "documentation"],
      "priority": 5,
      "manualOnly": false
    }
  ]
}
```

## Matching

The MVP lowercases the query and each trigger, then matches rules whose trigger
text appears in the query. Candidate score is:

```text
priority + matched trigger count
```

Candidates sort by descending score, then by skill name and rule id for stable
output.

## Safety Boundary

Rules are recommendations, not activation. The router fails closed when:

- the rules JSON is missing or malformed;
- `schemaVersion` is unsupported;
- rule ids are unsafe or duplicated;
- a rule references a missing `skills/<name>/SKILL.md`;
- `triggers` are empty or malformed;
- a rule points at a risky skill but does not set `manualOnly: true`.

Risky skills are detected from `skills/<name>/skill.meta.json` risk flags such as
`executesShell`, `networkAccess`, `credentialSensitive`, `destructive`,
`repoMutation`, or global/project write capabilities. This prevents automatic
routing suggestions from silently activating dangerous skills.

## Deferred Work

Future slices can add:

- richer semantic matching;
- routing fixtures/evaluation sets;
- workflow-chain integration;
- per-provider routing policy;
- explicit human-approved activation adapters.
