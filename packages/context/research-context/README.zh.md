# @deepseek-ai/dsh-research-context

[English](README.md) | 中文

基于 append-only Session log 的确定性、事件溯源科研上下文组装。服务拥有当前已确认的“研究追求”版本（内部仍存为 Kernel）、可选 Research Frame、非权威 Working State、稀疏 Inquiry Map、唯一 Decision Frontier、待决人工跃迁或权威提案与组装 manifest。研究追求是慢变量：每个已确认版本不覆写，当反馈确实改变科学对象、成功含义或禁止偷换项时，可由模型提议、人类确认一个澄清、调整或转向后继版本。一次性索引按已完成 turn 聚合原始用户、助手和工具结果事件；恢复时从同一日志重建。

## Config

必须配置 `kernel`、`maxViewChars`、`recentTurns` 和 `maxEvidenceTurns`，`frame` 可选。`retrievalAliases` 可声明同义术语，`maxViewTokens` 默认 48,000，`maxKernelTokens` 默认 512，`fallbackAuthorityTokens` 默认 4,096，`maxInquiryNodes` 默认 64。日志出现路由窗口后，Kernel＋Frame＋Working State 必须落在窗口的二十分之一内；权威层绝不静默截断。单独的 Kernel 上限可以防止常驻的长篇宣言在大窗口中持续消耗注意力。

## Service

`ctx.researchContext.assemble(session, requestMessages, goal?)` 返回不可变视图，其中包含渲染文本、组件 token 估算、选中／省略 turn、原始事件 seq 与 CPU 组装延迟。确定性 focus gate 把最新已接纳的直接用户请求分为 `continue`、`task` 或 `reframe`。只有短续接语会让 Working State、Goal、evidence roots 与无条件 recent turns 扩展召回；明确任务只用当前请求检索，同时把路线状态降为 provisional；强重构语义以及新 Session 的首个明确请求还会从视图中隐藏旧路线与 Goal。选择器随后组合精确词项、字符模糊匹配、配置别名与同步 `registerRetrievalProvider()` seam。`recordAssembly()` 把 `focusMode` 随 manifest 写入日志，供回放和 UI projection 使用。

默认恢复完整 loop。只有单个 loop 自身放不进预算时，索引才按原始 message 分成 dialogue／tool-evidence locator；命中的行必须与首个用户问题以及最近的前置对话一起作为 `parent-bridge` 恢复，不会输出无起因的工具碎片。工具结果会递归读取 `tool-result` 容器中的原始内容。

每个请求还会得到一个确定性的 Idea Lens（`execute`、`explore`、`audit` 或 `paper`）。Lens 最多选择五个允许模型读取的 Inquiry 节点，只扩展其一跳语义邻居并携带来源事件号；完整地图永不进入请求。人工白板卡片与边默认私有，画布坐标从不进入服务。当前图有上限并优先淘汰旧模型节点，但所有旧快照仍永久保留在 append-only `research/state-change` 事件中。

`updateInquiry()`、`raiseLeap()` 与 `resolveLeap()` 在不修改权威层的前提下维护临时科学推理。待决跃迁只暂停一个改变研究含义的动作，同时给出继续自主推进的证据前沿；它不会阻塞整个 Goal。人工节点对模型工具不可变，出现相反证据时必须追加，而不能重写研究者决定。

`proposeAuthority()` 会把后继版本分为 `clarify`、`adjust` 或 `pivot`，并强制携带简短 `basis`：哪个反馈使旧表述不再充分，新版本又明确保留什么。它不设固定冷却时间或多重审批；迟滞来自“先用最低充分层吸收反馈”：执行变化进 Working State，活跃未知进 Map／Frontier，路线或瓶颈变化进 Frame，只有研究追求本身变了才动慢变量。

`assembleWorker(workerSession, requestMessages, parentSessionId, parentView)` 用父级已选择的研究视图、子线程当前短任务和相关完整子线程 loop 编译一次子请求。父级 Kernel 保持为精确前缀。`recordInheritance()` 分开记录父级与子级来源地址，不会把跨 Session 来源误写成同一 Session 的 `sourceEventSeqs`。

`importHandoff(session, input)` 把 Codex／Pi／其他 Harness 的窄续接卡记录为 `research/handoff-imported` 事件。它是带外部 Session 与消息锚点的候选证据，不改变 Kernel、Frame 或 Working State。新 Session 只有在用户明确续接时才无条件携带最新 handoff bridge；task 与 reframe 必须先与当前查询命中。产生本地 loop 后，handoff 同样只在相关时恢复，因此迁移包不会永久占用每轮上下文。

每个 live Session 只有一个递增缓存。Session 创建和追加事件会调度每批 32 个事件的索引任务，并在批次间让出 event loop，因此普通请求通常直接读取已经预热的 locator 快照；真正的冷请求仍可同步补齐剩余尾部，不牺牲召回完整性。缓存永远不是真源；插件卸载时，Cordis 生命周期会移除服务、待执行预热任务和所有进程内索引。组装路径不调用模型、Obelisk 或远程服务。

## Model Experience

### 编译后的科研视图

#### What the model sees

视图逐字以受注意力上限约束的当前研究追求版本（Kernel）开头。随后一个很短的 `<objective-ladder focus-mode="…">` 明确：它是当前 Mission，但不是永恒真理；已确认 Frame 是当前瓶颈，本轮已接纳请求控制本轮，Working State 只是可替换路线，Goal 只是执行租约。已确认 Frame 与请求专属 `<idea-lens>` 排在可见的 `<task-idea-bridge status="provisional">` 与 `<active-goal authority="execution-lease">` 之前；reframe 视图不携带后两项路线状态。待决跃迁会明确唯一暂停动作和继续推进的证据动作。之后可包含相关 `handoff-bridge`、带 source seq 的完整历史 loop 与省略项定位符。待确认权威提案与私有白板项不会进入视图。超长 loop 使用带 `parent-bridge` 的 `mode="partial"` 边界；Manifest 记录精确 locator、partial turn、focus mode 与 Idea Lens。

#### Token effect

视图同时受字符数和估算 token 限制，Kernel 另有独立注意力预算；权威层与选中的 loop 都不截断。历史在达到上限前停止添加，权威层本身超限时直接失败。

#### KV Cache effect

服务本身不改变缓存；模型表面的消费插件决定放置与替换方式。

## Known Limitations and Deferred Work

- **语义能力取决于 provider**：内置路径只提供词法、模糊词形和显式别名；真正的 embedding／外部语义索引应实现同步 ready-snapshot provider，不得在关键路径等待模型或网络。
- **单个待确认提案**：新的 Kernel／Frame 提案会替换上一个待确认候选；所有已确认历史版本仍在 append-only log 中。
- **冷谱系查找**：自动子线程继承先查 live Session store，再只读调用 `sessionPersistence.inspect()`；不存在的来源保留普通子线程表面，不会伪造权威状态或隐式 resume。
