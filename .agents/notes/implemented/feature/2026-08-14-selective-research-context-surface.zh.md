# Agent Note：事件溯源的选择性科研上下文

状态：已实现

[English](2026-08-14-selective-research-context-surface.md) | 中文

## 问题

持续数周的科研 Session 需要普通滚动摘要无法保证的两件事：研究者确认的科学对象必须在每次恢复和压缩后逐字存活，而每次请求又应主要包含当前任务需要的证据。实现必须留在 DSH 的 plugin、Session、projection 与 UI seam 内；隐藏检索结果或可变缓存不能成为模型可见真相。

## 决策

**科研权威采用整体值事件流。** `@deepseek-ai/dsh-research-context` 为初始 Idea Kernel／Research Frame、Working State 替换、待确认权威提案以及精确确认／拒绝追加 `research/state-change`。Kernel 与 Frame 是用户确认的权威。模型可以替换 Working State 或提出一份完整权威候选，但只有 `/research confirm <proposal-id>` 能让候选成为权威。待确认提案不会进入模型上下文。包级 invariant 独立回放 state revision；权威文本不再携带无额外语义的 hash，提案并发检查使用 base version。只有 `viewHash` 保留，用于标识子线程实际看见的完整组装视图。

**权威出现不等于模型注意。** Kernel 只包含科学对象、成功证据和禁止偷换项；Pi-Idea bundle 为它设置独立 256-token 上限，超限失败而不截断。精确 Kernel 后紧跟一条短 objective ladder，依次标明 Mission、已确认瓶颈、当前请求、临时路线和执行 Goal。已确认 Frame 排在任何可见 `task-idea-bridge` 之前；Working State 与 Goal 分别标为可替换路线和执行租约，而不是额外权威。这样，对齐是一条小型决策接口，而不是假设一段很长的 Idea 前言会控制注意力。

**选择器处理完整 loop 和可丢弃索引。** 服务从 append-only log 增量索引已完成的用户／助手／工具结果 turn。完整 loop 优先；单个超长 loop 才建立 message-level dialogue／tool-evidence locator，并强制携带首个用户起因和最近前置对话的 parent bridge。确定性 focus gate 把最新直接请求分为 `continue`、`task` 或 `reframe`。只有短续接语会用 Working State／Goal 扩展 query、启用 evidence roots 并无条件携带 recent loops；明确任务只用当前请求检索；强重构语义及新 Session 的首个明确请求还会隐藏旧路线与 Goal。对于“核心是……”这类替换目标话术，检索 query 不包含被用户明确否定的旧路线。随后再组合词法、模糊词形、显式别名与可替换同步 provider。工具结果递归读取真实 `tool-result` 容器，不调用摘要模型。Session 创建与追加事件会按每批 32 个事件、批间让出 event loop 的方式预热 locator 索引；冷请求只同步补齐尚未完成的尾部。

**组装有界且可追溯来源。** 每份视图逐字以已确认 Kernel 开头，随后是 focus ladder、可选的已确认 Frame、按 focus 允许出现的 Working State／Goal、完整选中 loop 与省略 turn 定位符。Kernel＋Frame＋可见 Working State 必须落在最近一次已记录路由窗口的二十分之一内，路由尚未知时使用保守 fallback；完整视图另受字符与 token 双上限约束。权威值和已选 loop 都不截断。组装 manifest 与有界历史 projection 会记录 `focusMode`，因此保留或卸载路线状态的决定可以回放。选择过程不调用模型或远程服务。

**compaction seam 拥有模型可见性。** `@deepseek-ai/dsh-compaction-research-context` 在 step 1 记录 Manifest 并通过标准 compaction 事件暴露选择性视图，同时继承 DSH 原生 `compaction-basic`。常态不摘要；水位压力、真实 overflow 或手动 `/compact` 才走原生 rolling fallback。子线程先查 live 父链，再只读 `sessionPersistence.inspect()` 冷补载，不隐式 resume。

**可视化扩展 DSH 原生表面。** `ui-conversation` 在现有 ContextMeter 面板内部声明通用 `conversation.context.details` slot，并在输入框上方声明 input-dock slot。`@deepseek-ai/dsh-client-ui-research-context` 以 Goal／Todo 卡片家族的视觉语言加入紧凑 Idea 状态条；两个只读按钮分别检查已确认 Kernel／Frame 与 Working State，Idea 选择器负责按 Session 切换目标或关闭 Idea 组装。有界的近期 Manifest 仍在 ContextMeter 中展示。按 Session 的 Idea 目录与选择由[Workspace 多 Idea 与按 Session 选择](2026-08-16-workspace-ideas-and-per-session-selection.md)负责；完整时间线由 append-only Session event inspector 拥有。子线程 report／settlement 从原始消息投影为带 child/session 来源的候选证据，绝不自动提升为 Kernel／Frame。

**一个 bundle 完成组合。** `@deepseek-ai/dsh-pi-idea-context` 选择继承原生 basic compaction 的科研 provider，并组合科研状态、控制与浏览器渲染插件。AgentLoop、Session、模型适配器与 ContextMeter 仍由各自领域拥有。

## 考虑过的替代方案

**修改 AgentLoop 或 fork Session。** 拒绝：现有 waterfall、compaction、projection 和 slot seam 足够表达功能；特权 Pi-Idea 核心会破坏 DSH 的时空可组合性。

**每轮调用模型摘要。** 拒绝：它会在请求关键路径增加延迟、API 成本、事实漂移和第二权威。检索单元继续使用精确完整 loop。

**让模型建议自动成为权威。** 拒绝：模型可以填充执行状态、提出路线，但不能决定科学对象或成功标准。

**同步调用 Obelisk。** 拒绝：本地历史服务可用性不应阻塞主 loop。Obelisk 后续可实现兼容的可选检索 provider。

## 后果

原始 Session log 可以持续增长，而请求表面保持有界且可重建。重启会回放权威与 manifest，并在调度允许时于请求路径外重建可丢弃 locator 索引。在交付机器上的可复现 76 事件、多 MB fixture 中，冷组装测得 287,314 微秒，紧接着的 warm 组装为 21,913 微秒，完成让步式预热后的同一请求为 1,271 微秒；门禁仍采用 500,000 微秒 cold／100,000 微秒 warm 上限，而不把单机计时当作普遍常数。最终生产重启后，一个真实请求把约 8.9k-token 视图和 1 个命中 loop 在 1.48 ms 内组装完成。“继续做”等歧义输入依赖持久 Working State／Goal，而不是从两个字猜测；明确任务或 reframe 不继承这种路线惯性。三种情况现在有机械边界：用户确认的 Mission／Frame 变化、权威不变时的临时路线变化，以及近期路线、候选、monitor 或 Goal 取代科学目标的未经授权漂移。选择表面跨 turn 改变可能降低历史前缀 KV 命中，但同一 turn 的工具 step 保留前缀。当前选择器刻意保持词法化，不声称语义召回完整；Kernel 的位置和任务桥同样不能在没有成对任务表现证据时证明注意力或科研成功。
