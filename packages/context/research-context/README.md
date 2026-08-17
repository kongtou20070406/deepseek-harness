# @deepseek-ai/dsh-research-context

English | [中文](README.zh.md)

Deterministic, event-sourced research context assembly over the append-only Session log. The service owns the currently confirmed research-pursuit revision (stored as Kernel), optional confirmed Research Frame, non-authoritative Working State, sparse Inquiry Map, one Decision Frontier, pending human leap or authority proposal, and assembly manifests. The pursuit is a slow variable: each confirmed revision is append-only, while feedback may lead the model to propose and the human to confirm a clarified, adjusted, or pivoted successor. Its disposable index groups raw user, assistant, and tool-result events by completed turn; resume rebuilds that index from the log.

## Config

`kernel`, `maxViewChars`, `recentTurns`, and `maxEvidenceTurns` are required. `frame` is optional and `retrievalAliases` may declare equivalent terminology. `maxViewTokens` defaults to 48,000, `maxKernelTokens` to 512, `fallbackAuthorityTokens` to 4,096, and `maxInquiryNodes` to 64. Once a logged request exposes the route window, Kernel + Frame + Working State must fit within one twentieth of it; authority is never silently truncated. The separate Kernel cap prevents an always-present manifesto from consuming attention even when the route window is large.

## Service

`ctx.researchContext.assemble(session, requestMessages, goal?)` returns one immutable source-addressed view. A deterministic focus gate classifies the latest admitted direct user request as `continue`, `task`, or `reframe`. Only a terse continuation expands retrieval with Working State, Goal, evidence roots, and unconditional recent turns. An explicit task retrieves from the current request alone while exposing route state as provisional; a strong reframe, including a new Session's first explicit request, also suppresses the old route and Goal from the view. Selection then combines exact terms, character-level fuzzy matches, configured aliases, and synchronous scorers registered through `registerRetrievalProvider()`. `recordAssembly()` logs `focusMode` with the manifest for replay and UI projection.

Each request also receives one deterministic Idea Lens (`execute`, `explore`, `audit`, or `paper`). The lens selects at most five model-visible Inquiry nodes, expands only their immediate semantic neighbors, and carries source event numbers; the complete map never enters the request. Human board cards and edges default to private. Canvas positions never enter the service. Current graph state is capped and preferentially discards old model nodes, while every prior snapshot remains in append-only `research/state-change` events.

`updateInquiry()`, `raiseLeap()`, and `resolveLeap()` maintain provisional scientific rationale without changing authority. A pending leap names exactly one blocked meaning-changing action and an evidence frontier that remains autonomous; it never blocks the whole Goal. Human nodes are immutable to model tools, so contrary evidence must be appended rather than rewriting the researcher's choice.

`proposeAuthority()` classifies a successor revision as `clarify`, `adjust`, or `pivot` and requires a concise `basis`: which feedback made the old wording insufficient and what the replacement deliberately preserves. There is no fixed cooldown or approval chain. Hysteresis comes from using the lowest sufficient layer first: execution changes go to Working State, live uncertainty to Map/Frontier, route or bottleneck changes to Frame, and only a changed research pursuit reaches the slow variable.

Complete loops are preferred. Only an individually oversized loop falls back to message-level dialogue/tool-evidence locators. Every selected row is restored with the first user cause and nearest preceding dialogue as a `parent-bridge`; nested `tool-result` content is indexed recursively.

`assembleWorker(workerSession, requestMessages, parentSessionId, parentView)` compiles a child request from a parent-selected research view, the child's current short task, and relevant complete child loops. The parent Kernel remains the exact prefix. `recordInheritance()` logs parent and child source addresses separately, so cross-session provenance is never confused with same-session `sourceEventSeqs`.

`importHandoff(session, input)` records a narrow continuation card from Codex, Pi, or another harness as a `research/handoff-imported` event. It is source-addressed candidate evidence and cannot mutate Kernel, Frame, or Working State. A new Session carries the latest handoff bridge unconditionally only for an explicit continuation; task and reframe requests require a query match. After a local loop exists, handoffs likewise return only when relevant, so an import does not become permanent per-request baggage.

The cache is per live Session and advances only across new events. Session creation and append events schedule 32-event index batches with an event-loop yield between batches, so ordinary requests normally see a prewarmed locator snapshot; a cold request can synchronously finish any remaining tail without sacrificing recall. The cache is never a fact source. Disposal removes the service, pending warmers, and all process-local indexes through Cordis lifecycle ownership. No assembly path calls a model, Obelisk, or a remote service.

## Model Experience

### Compiled research view

#### What the model sees

A consumer may log and expose the verbatim, attention-capped active pursuit revision (Kernel) first. A short `<objective-ladder focus-mode="…">` then states that it is the current Mission, not an eternal truth; the confirmed Frame is the bottleneck, the admitted request controls the turn, Working State is a replaceable route, and Goal is only an execution lease. The confirmed Frame and request-specific `<idea-lens>` precede any visible `<task-idea-bridge status="provisional">` and `<active-goal authority="execution-lease">`; reframe views omit the latter route state. A pending leap says which single action waits and which evidence actions continue. Relevant `handoff-bridge` entries, selected historical evidence with source seqs, and locators for omitted turns follow. Pending authority proposals and private board items are excluded. Oversized loops use a `mode="partial"` boundary with a `parent-bridge`; the manifest records exact locators, partial turns, focus mode, and Idea Lens.

#### Token effect

The consumer caps each view by both characters and estimated tokens. The Kernel also has an independent attention budget. This service never truncates an authority layer or a selected turn; it stops adding history before the cap and fails closed when authority itself exceeds budget.

#### KV Cache effect

The service itself has no direct cache effect. A surface consumer determines placement and replacement behavior.

## Known Limitations and Deferred Work

- **Provider-bounded semantics** — the built-in path supplies lexical, fuzzy-form, and explicit-alias recall. Embedding or external semantic indexes must expose a synchronous ready snapshot and may not block the request path.
- **One pending proposal** — a new Kernel/Frame proposal replaces the previous pending candidate; confirmed historical revisions remain in the append-only log.
- **Cold lineage lookup** — child inheritance checks the live store, then read-only `sessionPersistence.inspect()`. Missing sources preserve the ordinary child surface without inventing authority or implicitly resuming a session.
