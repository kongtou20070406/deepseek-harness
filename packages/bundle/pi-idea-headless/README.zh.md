# @deepseek-ai/dsh-pi-idea-headless

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-pi-idea-context`](../pi-idea-context/README.md) 的 headless 专用伴随 bundle。它应叠加在共享上下文 bundle 之后、`dsh-headless` 之前。

该 patch 禁用 base 根域的 `compaction-basic`，并插入 `compaction-research-context`。headless 没有隔离的 Agent preset，因此它成为根 Agent 以及该作用域创建的子 Agent 的唯一上下文组装器。Web profile 不应加载本层；standard/code preset 会在各自 Agent 作用域内持有 compaction。

## Model Experience

本层通过所选择的科研上下文 compaction 间接影响模型；它自身不增加提示词、工具或模型可见文本。

#### KV Cache effect

本层自身无直接影响；所选择的 compaction provider 持有历史前缀替换行为。

## Known Limitations and Deferred Work

- 必须在共享 Pi-Idea 上下文层之后加载，以获得 `researchContext` 服务。
- 只适用于没有隔离 Agent preset compaction 域的 profile。
