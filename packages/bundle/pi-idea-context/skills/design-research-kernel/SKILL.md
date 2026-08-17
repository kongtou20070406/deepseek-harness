---
name: design-research-kernel
description: Form or slowly revise a concise Pi-Idea research pursuit without pretending the researcher already knows the final goal. Use when initializing an Idea, incorporating feedback that may clarify/adjust/pivot the pursuit, or repairing a pursuit that is verbose, route-specific, attention-heavy, or over-constraining.
---

# Design a research pursuit

The runtime still stores this value as `Kernel` for compatibility. Treat it as the currently active **Pursuit Seed**: a slow variable, not an eternal contract and not a research plan.

## Recover what is actually being pursued

Start from the researcher's own words and current feedback. Distinguish:

1. **Confirmed direction** — what the researcher is already sure is worth pursuing.
2. **Open meaning** — what they are still learning from feedback; leave it open rather than filling it with model confidence.
3. **Dangerous substitution** — the most plausible local proxy that could silently replace the real pursuit.

Do not force all three into labeled fields when one is absent. Methods, named architectures, tools, schedules, current hypotheses, resource policy, and workflow belong in Research Frame or Working State unless the researcher explicitly makes one part of the scientific claim.

## Decide whether the slow variable needs to move

Prefer the lowest sufficient layer:

1. next action -> Working State;
2. live question or rival -> Inquiry Map / Decision Frontier;
3. route or bottleneck -> Research Frame;
4. scientific object, success meaning, or dangerous substitution -> Pursuit Seed.

Do not revise the Pursuit Seed merely because an experiment failed, a route changed, or a new method looks attractive. Do revise it when the researcher explicitly reorients the project or when feedback makes the old pursuit an inaccurate description of what is now worth doing.

Classify a successor as:

- `clarify`: the pursuit is the same, but its wording or boundary becomes more accurate;
- `adjust`: the pursued outcome or scope changes while substantial commitments remain;
- `pivot`: the scientific object or meaning of success changes materially.

The proposal basis must say what feedback made the old revision insufficient and what the successor deliberately preserves. The user does not need to prove a pivot formally.

## Keep the candidate light

Apply these tests to every clause:

- **Falsification:** could future evidence show this clause unmet?
- **Decision:** would deleting it change the final accept/reject judgment?
- **Freedom:** does it constrain the result, or merely prescribe a process?
- **Substitution:** does it prevent a realistic local proxy from impersonating scientific success?

Use the tests as lint, not as a form the researcher must fill. Delete clauses that fail the decision test. Move process constraints out. Prefer 60-120 Simplified-Chinese characters or one to three short sentences; never compensate for uncertainty with a long manifesto.

## Persist the slow change

Apply the Runtime's material-ambiguity boundary before changing the Seed or Frame. If one reading is consistent with the user's feedback, persist the complete successor with `update_research_idea`, its `clarify`/`adjust`/`pivot` scope, the feedback basis, and what remains. State what was deliberately left open or moved to Frame, Map, or Working State.

If at least two plausible readings would change the scientific object, success meaning, forbidden substitution, or one high-lock-in action, call `manage_idea_discussion` with `action=open`, ask its single question, and pause only the conflicting action. After the user's clear answer, resolve the discussion and then persist the successor. Do not treat a model-generated candidate, novelty, or confidence as user feedback for a Seed pivot.

The researcher may directly inspect or replace the Session's Idea with `/idea`, `/idea set ...`, or `/idea frame ...`. Do not create a Workspace-wide target or copy the revision into another Session.

After confirmation, express the current task in Working State as a narrow bridge: name the evidence this task should produce toward the active pursuit. Label infrastructure work as enabling work, not scientific progress.
