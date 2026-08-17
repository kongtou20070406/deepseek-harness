# @deepseek-ai/dsh-pi-idea-context

English | [中文](README.zh.md)

Context-only Pi-Idea bundle for DeepSeek Harness. Stack it after `dsh-base` and before `dsh-web-app` or `dsh-headless`.

Each Session owns one append-only Idea. A neutral initial Seed is replaced from the conversation's first clear goal; later feedback may slowly clarify, adjust, or pivot it. Old Workspace Ideas are cloned lazily into old Sessions once and then become independent. `/idea` is the human view/edit surface, while the model maintains clear revisions and automatically persists material ambiguity as a one-question discussion.

Working State changes faster. Inquiry and evidence remain absent until a real decision or source-addressed result exists. The selective context assembler keeps the stable Idea prefix, restores only task-relevant complete loops, and falls back to native DSH compaction only under real pressure.

## Model Experience

### Pi-Idea request surface

#### What the model sees

A bounded `<research-context>` with the Session Idea, optional Frame and task bridge, an optional sparse Idea Lens, and selected complete history loops. One short stable policy plus five small state tools govern maintenance and automatic discussion. Skill descriptions remain in the ordinary catalog; bodies load only when selected.

#### Token effect

No model summary or second ambiguity classifier runs on the hot path. Empty evidence fields and Workspace catalogs add zero tokens. Stable policy, tool schemas, and the slow Idea prefix maximize cache reuse.

#### KV Cache effect

Stable policy and Idea text form a reusable prefix. Fast Working State, discussion state, and request-specific evidence follow it, limiting invalidation to the changing suffix.

## Known Limitations and Deferred Work

- The main model judges semantic ambiguity; Runtime state prevents unresolved discussions from being silently bypassed.
- Evidence markers support retrieval but do not prove scientific closure.
