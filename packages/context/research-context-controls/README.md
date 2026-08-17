# @deepseek-ai/dsh-research-context-controls

English | [中文](README.zh.md)

Compact controls for one persistent Idea per Session. `/idea` shows it; `/idea set <text>` and `/idea frame <text>` replace the complete Seed or Frame. The top-level model may maintain the same state with `update_research_idea` after unambiguous feedback.

Material ambiguity is automatic. The stable policy tells the model to call `manage_idea_discussion` when two plausible readings would change the research object, success criterion, forbidden substitution, or a high-lock-in action. The discussion is persisted, only the conflicting action pauses, and Idea mutation is rejected until the next clear user answer resolves it.

Inquiry and evidence state are optional. Empty placeholders are forbidden; real evidence is stored as a short marker plus source event locators.

## Model Experience

### Session Idea controls

#### What the model sees

One stable policy paragraph and five small tools: state read, Idea update, Working State update, sparse Inquiry update, and Idea discussion management. `/research` remains for advanced and legacy commands.

#### Token effect

No second classifier call is used. The main model applies the short trigger rule; Skill bodies load only when selected. Tool results occur only after an actual state change.

#### KV Cache effect

The stable policy and schemas preserve the request prefix. Seed or Frame edits invalidate only the later Idea prefix for that Session.

## Known Limitations and Deferred Work

- Semantic ambiguity detection uses the active model's judgment; the Runtime enforces persistence and mutation ordering after detection.
- Evidence markers aid retrieval and do not decide scientific closure.
