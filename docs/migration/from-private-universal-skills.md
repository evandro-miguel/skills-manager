# Migration: Extracting Universall Skill-Sys

This repository starts from the declared public engine surface of the original
Skill-Sys worktree. The extraction goal is to make the engine independently
reviewable before the repository owner explicitly approves any GitHub-public
launch or package publishing.

This migration originally defined a two-repo staging model. The current private
skills direction no longer requires a private mirror repo for personal skills:
the engine stays public/base, while user skills live in a User Skill Root that
may be unversioned or backed by any repository the user chooses.

## Engine plus user-owned-root architecture

- `universall-skill-sys` — base/public-engine repository. It carries engine
  code, schemas, provider metadata, artifact-surface policy, synthetic fixtures,
  public docs, and package/release gates.
- user skill root — private skills outside the engine repo, resolved from
  `--user-root <dir>`, then `SKILL_SYS_USER_ROOT`, then `~/.skill-sys`, with
  layout `<userRoot>/skills/<skill>/SKILL.md`. This root may be a plain local
  directory or a Git checkout owned/versioned wherever the user chooses.

No project-owned first-party personal skillpack repository is part of this
architecture. Users may create or choose their own private/public/internal Git
repository for their User Skill Root, but that repository is user policy and not
a required engine companion repo.

Public/private alignment note: keep private skill content in User Skill Roots
and keep it out of this repo. User roots are not packed, released, audited as
public artifacts, or pushed by engine release workflows. If a user root is Git-
versioned, its remote/visibility are chosen and managed by the user.

## Boundary decisions

- Engine code, schemas, provider adapters, audit commands, and release tooling
  live here.
- Private skill content stays in User Skill Roots unless an explicit separate
  distribution workflow is approved later.
- Do not create or require a project-owned first-party personal skillpack repo.
- Users may version their own User Skill Root in any repo they choose; that repo
  must not be treated as part of this engine's release/publication surface.
- Independent public/community skillpacks may exist later for shareable
  non-private content, but they are outside the private user-root architecture.
- Synthetic examples may live under `examples/`.
- Runtime state, local workbench data, credential-bearing state files, and
  host-specific workflows stay out of this repository.
- Projection includes user-root skills only with `--include-user`; duplicate
  names across public and user origins fail closed. User projection metadata uses
  `origin: "user"` and `canonicalPath: "user:skills/<skill>"`.

## Initial staging gates

```bash
bun run validate
bun run public:audit
bun run packlist
```

## Next milestones

1. finish source/package branding and command references;
2. formalize the package publication policy;
3. add release provenance automation;
4. consider real public/community skillpack repositories only for non-private
   shareable content after this engine is stable and the repository owner approves
   publication; keep private skills in User Skill Roots by default, versioned in
   whichever repo the user chooses.
