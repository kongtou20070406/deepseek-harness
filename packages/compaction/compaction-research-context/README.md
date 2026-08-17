# @deepseek-ai/dsh-compaction-research-context

English | [中文](README.zh.md)

Selective research-surface provider that exposes one logged view per turn. It consumes `ctx.researchContext` plus the existing same-session Goal and replaces the prior model-visible Session surface through the existing compaction event protocol; the append-only raw event log remains unchanged. It subclasses native `compaction-basic`: ordinary assembly is model-free, while pressure, provider overflow, and manual `/compact` keep DSH's rolling-summary recovery.

For a subagent Session, it follows `parentSession` to the top-level research Session. A live-store miss uses read-only `sessionPersistence.inspect()` without publishing or resuming the cold Session. The parent model never writes or receives the expanded task package.

## Lifecycle

The plugin delegates through `agent/pre-step`, acts only on step one, and uses the downstream-admitted current messages as the retrieval query. With no prior surface it prepends a sourced view to the admitted batch. With prior history it appends `compaction/start`, `compaction/summary`, one replacing `user/message`, and `compaction/end` before the request. Later tool steps keep their complete live chain.

Every registration is owned by the plugin fiber. Unloading removes both the selective pre-step listener and inherited native compaction service; already logged events remain replayable facts.

## Failure behavior

Assembly or replacement failure logs a warning and preserves the full ordinary DSH surface. A selector failure therefore costs compression but does not discard the user's prompt or prevent the model request.

## Model Experience

### Per-turn selective history

#### What the model sees

The current prompt follows one logged research-context view. The view begins with the confirmed Kernel and may contain the confirmed Frame, Working State, current Goal, complete selected historical loops, and omitted-turn locators. The assembly manifest is logged before the request so browser projections and replay inspect the same decision. The replacement is committed through `compaction/start`, `compaction/summary`, a replacing `user/message`, and `compaction/end`; no private message array bypasses Session.

#### Token effect

The prior visible surface is replaced by one bounded view before each first step. Tool continuation steps append normally and remain intact until the next turn.

#### KV Cache effect

Each new turn replaces the earlier surface and may invalidate conversation-history cache entries after the stable system prompt. This trades cross-turn history-prefix reuse for bounded request size; within one tool loop, later steps retain the current prefix.

## Known Limitations and Deferred Work

- **Whole-surface turn boundary** — selective replacement occurs only at step one; a process that ends before the next turn retains the completed turn on its visible surface.
- **External retrieval stays off the hot path** — the consumer accepts local ready-snapshot providers. Obelisk remains a Skill/external tool and is never synchronously called here.
- **Rolling summaries are fallback only** — pressure, actual overflow, or manual `/compact` enters native DSH summarization; it is not an ordinary assembly stage.
