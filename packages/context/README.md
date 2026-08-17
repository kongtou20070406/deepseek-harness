# context/ — request-context extensions

English | [中文](README.zh.md)

Product plugins that add model-visible request context without defining a tool. `agent-instructions` is included by the default `dsh-agent-spine-demo` bundle and can be disabled through bundle config; `time-context`, `tmux-context`, and `session-reference` are opt-in.

| Package | Role | ctx key |
|---|---|---|
| [`session-reference/`](session-reference/README.md) | Bounded snapshots of other sessions | `ctx.sessionReferenceResolver` |
| [`time-context/`](time-context/README.md) | Current-time and elapsed-time context | — |
| [`research-context/`](research-context/README.md) | Deterministic research-history selection from the durable Session log | `ctx.researchContext` |
| [`research-authority-workspace/`](research-authority-workspace/README.md) | Durable multi-Idea-per-Workspace authority provider | research authority provider seam |
| [`research-context-controls/`](research-context-controls/README.md) | Model proposal/Working State tools and human authority confirmation | command + tools |
| [`model-execution-policy/`](model-execution-policy/README.md) | Exact-route lean autonomy and confirmation guidance | — |
| [`tmux-context/`](tmux-context/README.md) | tmux location context | — |
| [`agent-instructions/`](agent-instructions/README.md) | Workspace-instruction context | — |

Session references are documented in [docs/subsystems/session-reference.md](../../docs/subsystems/session-reference.md); the [`agent-instructions` decision record](../../.agents/notes/implemented/feature/2026-06-24-workspace-context.md) owns its per-agent/session isolation and lifecycle split.
