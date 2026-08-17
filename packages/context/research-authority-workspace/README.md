# @deepseek-ai/dsh-research-authority-workspace

English | [中文](README.zh.md)

Read-only compatibility bridge for the retired Workspace Idea catalog. When an old Session has no `research/state-change`, the bridge reads that Session's former Workspace selection and lets `ctx.researchContext` append one `migrate-session-idea` snapshot. It never writes the old catalog and is never consulted again for that Session.

New and migrated Ideas are Session-owned. Editing one conversation cannot change another conversation, even when both use the same Workspace.

## Model Experience

### Lazy legacy migration

#### What the model sees

Nothing extra. The cloned Idea enters the ordinary Session research view.

#### Token effect

Zero recurring tokens. Migration creates one durable state event only for an unmigrated old Session.

#### KV Cache effect

None beyond the normal Idea prefix inherited by that Session.

## Known Limitations and Deferred Work

- The old catalog remains on disk for recovery but is no longer editable or authoritative.
- A Session with no old catalog entry starts from the bundle's neutral seed.
