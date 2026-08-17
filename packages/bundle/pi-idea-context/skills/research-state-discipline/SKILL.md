---
name: research-state-discipline
description: Maintain one Session-owned persistent Idea, concise Working State, optional source-addressed evidence markers, and automatic material-ambiguity discussions. Use when resuming research, interpreting “continue”, recording a result, changing a research direction, or deciding whether a user instruction needs clarification before action.
---

# Research state discipline

Write human-facing state in Simplified Chinese. Persist only what a later loop needs.

## State speeds

Use the lowest layer that can absorb new feedback:

1. Working State: current task, verified unresolved items, one next action, decisive turn locators.
2. Inquiry Map / Decision Frontier: a real question, rival, decision, or source-backed result.
3. Research Frame: the current route or scientific bottleneck.
4. Idea Seed: the slowly evolving research object, success meaning, and dangerous substitutions.

Each Session owns its Idea. Do not copy changes into another Session or a Workspace-wide catalog. Update the complete Seed or Frame with `update_research_idea` after clear feedback; include `clarify`, `adjust`, or `pivot`, the feedback basis, and what remains. Preserve prior versions in the Session event log.

## Automatic ambiguity discussion

Use exactly the same trigger boundary as the Runtime:

- Proceed without asking when the instruction has one action-consistent reading.
- Automatically call `manage_idea_discussion` with `action=open` only when at least two plausible readings would change the research object, success criterion, forbidden substitution, or one high-lock-in action.
- Ask exactly the persisted question. Pause only the named conflicting action; unrelated reversible work may continue.
- On the next clear user answer, call `manage_idea_discussion` with `action=resolve`. Then update Seed or Frame only if the clarification actually changed it.

Do not trigger discussion for ordinary implementation choices, reversible experiments, low confidence, resource presence, warnings, or wording that does not change action. Do not require evidence before asking a genuine ambiguity question.

## Sparse evidence

Leave evidence state empty until real evidence exists. Never create placeholder cards, empty contracts, or a complete argument graph.

When a result matters later, add only a short evidence or counterevidence marker with exact `source_seqs`; keep raw data in its original event or artifact. Add a Decision Frontier only when one answer would change the next action. Evidence links guide retrieval and do not declare scientific closure.

After one result, run at most one bounded review when it changes a hypothesis, rival, next experiment, support requirement, or shared-route diagnosis. Otherwise keep the raw locator and continue.

## Efficient continuation

Call `get_research_state` after resume, compaction, handoff, or an ambiguous “继续”. Use `update_research_working_state` only after a meaningful phase, blocker, or next-action change. Do not store narrative logs, tool dumps, duplicated Idea text, speculative blockers, or resolved objections.

Rank admissible actions by expected scientific information gain. Resource presence is not interference. Treat a process, warning, monitor, or nonzero GPU/CPU use as a blocker only after measuring impact on the acceptance-relevant quantity or applying a current user threshold.

If no in-scope action can add useful evidence, park and name the missing condition. Do not manufacture safe busywork.
