# Ephemeral Use Spec

PR05 ships a read-only `skill-sys use` preview. It reads a skill from a local
skillpack or fetches a remote source into an isolated temporary checkout, runs
the sensitive scanner before emitting prompt material, and never writes to a
project root, a global root, or the user's HOME directory.

## Current scope: local and remote preview

```bash
skill-sys use ./local-skillpack --skill <name>
skill-sys use ./local-skillpack --skill <name> --format json
skill-sys use ./local-skillpack --skill <name> --agent codex
skill-sys use owner/repo --skill <name>
skill-sys use owner/repo#ref --skill <name>
skill-sys use https://github.com/owner/repo --skill <name>
skill-sys use https://github.com/owner/repo/tree/main/skills/<name>
```

The local form resolves a skill directory from a skillpack layout and reads
`SKILL.md`. The remote form accepts `owner/repo`, `owner/repo#ref`, Git URLs,
and GitHub tree URLs, resolves the ref through advertised `HEAD`, and fetches
into an isolated temporary directory.

## Fail-closed rules

- Local sources must exist and be directories; the requested skill must include
  `SKILL.md`.
- Remote sources must resolve through the same safe source grammar as
  add/install, including ref safety and remote host checks.
- Remote refs are resolved through advertised `HEAD` rather than defaulting to a
  floating `main`.
- The sensitive scanner runs on the resolved skill directory before any content
  is emitted; sensitive findings block output.
- Symlinked skill directories and `SKILL.md` files are refused for remote
  checkouts.

## No-write guarantee

`skill-sys use` only reads skill content and returns it as markdown or JSON. It
does not create `.agents/skills`, `.skills.state.json`, global skill roots, or
HOME-directory state. Remote checkouts live under the OS temporary directory and
are removed after use, including on sensitive-scan failures.

## Test seams

Remote use accepts an injectable `resolveRemoteRef` and `fetchExactRef` so tests
can prove the fetch/scan/cleanup behavior without network access. Local use is a
pure filesystem read plus scan.
