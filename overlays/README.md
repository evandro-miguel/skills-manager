# Provider Overlays

Provider overlays are optional deltas applied by `build-projections`.

Canonical skill content remains under `skills/` relative to a skillpack or User
Skill Root source root. The base repo does not carry real private root `skills/`
catalogs; user-local private skills should live under a User Skill Root
(`SKILL_SYS_USER_ROOT` or `~/.skill-sys`) by default. If users want versioning,
they choose the repository for that root. This directory is checked in so release
tooling can treat provider overlays as part of the artifact surface once provider
projections exist.
