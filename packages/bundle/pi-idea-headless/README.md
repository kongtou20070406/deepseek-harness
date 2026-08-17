# @deepseek-ai/dsh-pi-idea-headless

English | [中文](README.zh.md)

Headless-only companion for [`@deepseek-ai/dsh-pi-idea-context`](../pi-idea-context/README.md). Stack it after that shared context bundle and before `dsh-headless`.

The patch disables base's root `compaction-basic` row and inserts `compaction-research-context`. Headless has no isolated Agent preset, so this is the single compaction owner for its root Agent and any child Agents created in that scope. Web profiles must not load this layer; their standard/code presets own compaction inside each Agent scope.

## Model Experience

Indirectly, through the selected research-context compaction implementation: this layer adds no prompt text, tools, or model-visible content of its own.

#### KV Cache effect

None directly; the selected compaction provider owns history-prefix replacement.

## Known Limitations and Deferred Work

- Requires the shared Pi-Idea context layer before it so `researchContext` is available.
- Intended only for profiles without an isolated Agent preset compaction realm.
