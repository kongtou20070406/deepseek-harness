# @deepseek-ai/dsh-compaction-research-context

[English](README.md) | 中文

选择性科研表面 provider：每个 turn 暴露一份已记录的科研上下文视图。它消费 `ctx.researchContext` 与现有同 Session Goal，并通过 DSH 的 compaction 事件协议替换旧的模型可见表面；append-only 原始事件日志保持不变。它继承 DSH 原生 `compaction-basic`，因此常态组装不调用模型，而真实水位压力、provider overflow 与手动 `/compact` 仍走原生滚动摘要路径。

对于 subagent Session，它沿 `parentSession` 找到顶层研究 Session，用子线程当前短任务检索父级证据，再把继承视图与相关的子线程本地完整 loop 编译在一起。live store 未命中时只读调用 `sessionPersistence.inspect()`，不会发布或 resume 冷 Session。父模型不需要编写或接收展开后的长任务包。

## Lifecycle

插件在 `agent/pre-step` waterfall 中先调用 `next()`，只处理 step 1，并以已准入当前消息作为检索查询。没有旧表面时，它把带来源的视图放在当前消息之前；存在历史时，它在请求前追加 `compaction/start`、`compaction/summary`、替换用 `user/message` 与 `compaction/end`。后续工具 step 保留完整 live 链。

所有注册都归插件 fiber 所有。卸载会同时撤销选择性 pre-step listener 与继承来的原生 compaction service，已记录事件仍可回放。

## Failure behavior

组装或替换失败时记录警告并保留完整普通 DSH 表面。选择失败只损失压缩，不会丢弃用户问题或阻止模型请求。

## Model Experience

### 每 turn 选择历史

#### What the model sees

当前提示跟在一份已记录的科研上下文视图之后。视图逐字以已确认 Kernel 开头，可包含已确认 Frame、Working State、当前 Goal、完整历史 loop 与省略 turn 定位符。请求前记录 assembly manifest，因此浏览器 projection 与回放检查同一个决定。替换通过 `compaction/start`、`compaction/summary`、替换用 `user/message` 和 `compaction/end` 提交；不存在绕过 Session 的私有消息数组。

#### Token effect

每个 turn 的 step 1 前用一份有界视图替换旧表面；当前工具循环的后续 step 正常追加并保持完整，直到下一 turn。

#### KV Cache effect

跨 turn 替换可能使稳定系统提示之后的对话历史缓存失效，以此换取有界请求大小；同一工具 loop 内保留当前前缀。

## Known Limitations and Deferred Work

- **整表面 turn 边界**：只在 step 1 做选择替换；进程若在下一 turn 前退出，已完成 turn 仍留在可见表面。
- **外部检索不在关键路径**：当前只消费本地 ready-snapshot provider；Obelisk 保持 Skill／外部工具，不由本插件同步调用。
- **滚动摘要只兜底**：水位压力、真实 overflow 或手动 `/compact` 才会进入 DSH 原生摘要；它不是日常组装步骤。
