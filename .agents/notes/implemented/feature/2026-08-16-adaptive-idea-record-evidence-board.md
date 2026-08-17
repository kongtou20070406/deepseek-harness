# Agent Note: Project an Adaptive Idea Record into each research request

Status: implemented

English | [中文](2026-08-16-adaptive-idea-record-evidence-board.zh.md)

## Problem

A long-running research agent needs durable scientific continuity without placing the entire research history or a rigid, ever-growing frame in every model request. A fixed prompt can preserve wording while still over-constraining inquiry, and a full argument graph consumes attention even when most of it is irrelevant to the current action. Human supervision also becomes inefficient when every tentative idea or ordinary experiment is treated as an approval gate.

## Decision

**Pi-Idea stores an Adaptive Idea Record outside the model and projects one narrow Idea Lens per request.** The user-confirmed Idea Seed is redefined as a research-pursuit slow variable: every confirmed revision is preserved, but when feedback exposes a more worthwhile scientific object, success meaning, or boundary, the active revision may be clarified, adjusted, or pivoted through a model proposal and one human confirmation. A bounded Inquiry Map stores typed questions, hypotheses, rivals, evidence, counterevidence, decisions, and rejection reasons. One Decision Frontier identifies the live question with the highest expected decision value. The context assembler selects at most five relevant visible nodes plus necessary one-hop relations for execute, explore, audit, or paper work; the full map never becomes a permanent prompt section.

State evolves on four timescales: Working State changes quickly, Inquiry Map/Decision Frontier track live uncertainty, Research Frame changes at medium speed when the route or bottleneck changes, and the research pursuit changes slowly. There is no fixed cooldown or multi-stage approval chain; the system first asks which lowest layer is sufficient to absorb the feedback. A slow-variable proposal records `clarify`, `adjust`, or `pivot` plus both the feedback that made the old revision insufficient and the commitments deliberately preserved. This lets a researcher discover what is worth pursuing through feedback rather than pretending to know the final goal at initialization.

Scientific evidence progress outranks generic safety caution. Safety is an action-admission check, not a competing research objective. New data triggers at most one bounded review only when it changes a live hypothesis or rival, the Decision Frontier, a paper evidence obligation, or a shared-route diagnosis. The model may generate and test provisional ideas under the existing Seed when evidence supports them. Only a proposal that changes the scientific object, success criterion, or forbidden substitution becomes a human-owned leap. A pending leap blocks its named action while independent evidence work continues. When no action has positive information value, the agent parks and records what evidence is missing.

Autonomy does not license filling evidence gaps with invented detail. The controller and on-demand Skill require an underspecified mechanism, domain fact, or ablation arm to remain an explicit missing discriminator. When one next action is requested, the model selects one highest-value intervention; measurements within that intervention may be bundled, but alternative interventions may not be relabeled as one action.

The Web client exposes the same state as a compact research console and a sidebar detective evidence board. The board pre-renders AI and human cards and semantic edges. Dragging a card writes only workspace-scoped local layout; it never changes a revision, context manifest, or model token. Creating or editing a card, adding a relation, or explicitly changing model visibility goes through the research command service and becomes append-only semantic state. Human additions are private by default.

## Verification

Domain tests cover task-specific lens projection, hidden-card exclusion, bounded current maps with raw event retention, nonblocking leaps, immutable human decisions, and private-until-shared board semantics. Client tests cover console rendering, leap resolution, Cordis slot registration and disposal, semantic command emission, and the critical invariant that drag movement updates only local storage and emits no research command. Host and client TypeScript project builds and the production Web build pass. Live browser acceptance created, shared, dragged, reloaded, and semantically connected cards. Five DeepSeek V4 Flash High cases passed after one paper scenario exposed and then verified the fix for invented ablation detail.

Final acceptance used a separate `dsh-self-bootstrap-acceptance` Workspace and a new primary conversation. In the same Session, DeepSeek confirmed Pursuit/Frame v2, changed real source code, reduced two `toReversed()` full-array clones to zero, ran the focused test with 29/29 passing, and wrote back `keep`. After the production build and DSH restart, the same Session and slow-variable versions were restored, and an empty `next_action` correctly rendered `Parked`. The live run also found and fixed two contract bugs: a second pending authority proposal silently replacing the first, and the backend rejecting a contractually valid empty next action. The corresponding service and Idea Dock regressions pass 32/32.

## Alternatives considered

**Inject the full Inquiry Map into every request.** Rejected: it spends tokens and attention on dormant branches and recreates long-context degradation inside a structured format.

**Replace the map with a rolling model summary.** Rejected: summaries are useful only as a pressure fallback; they are not a traceable authority source and may silently erase rivals or negative evidence.

**Require approval for every new hypothesis or experiment.** Rejected: it turns the researcher into a scheduler and prevents autonomous evidence production. Human authority is reserved for slow-variable successors, meaning-changing leaps, and voluntary intervention.

**Freeze the initial Idea Seed forever.** Rejected: it prevents local work from silently replacing the goal, but it also turns early incomplete understanding into a durable bias. Preserved revisions and a human confirmation boundary are sufficient to prevent silent drift without forbidding evidence-driven evolution.

**Let board layout affect retrieval priority.** Rejected: visual organization is for human cognition. Only explicit semantic edges, node content, status, and visibility may affect model context.

## Consequences

Research continuity is stored durably while each request receives only the evidence needed for its current decision. The model can continue working through ordinary uncertainty, propose evidence-grounded refinements, and stop honestly when no informative action remains. The user can intervene at any time and can gradually revise what is actually worth pursuing without being locked to early wording. Current-map size is bounded, while append-only Session events preserve provenance for later reconstruction and audit.
