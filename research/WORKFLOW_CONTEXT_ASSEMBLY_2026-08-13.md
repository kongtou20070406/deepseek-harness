# Pi-Idea Workflow 工具线程上下文合同

日期：2026-08-13
状态：实现接口已落地；按用户要求不再做模型 benchmark。

## 目标

工具线程用于隔离机械工作，不是复制主对话。它只获得完成一个冻结任务所需的最小工作集；主 Sol 保留科学判断、方向变更和最终采纳权。

## 输入包

每个 Workflow 只接收四层内容，顺序固定：

1. **Frozen task card**：objective、input refs、ownership、dependencies、acceptance、allowed/forbidden operations、time/token/tool limits、return contract；
2. **Research coordinate**：Idea hash/version 与 stage hash，只用于阻止跨方向污染，不重复注入完整主对话；
3. **Exact evidence islands**：task card 明确引用的完整 dialogue/tool-evidence block，带 raw hash；
4. **Return contract**：`status/result/evidence_refs/state_delta/artifacts/uncertainty_or_risk`。

不继承主线程 system prompt、聊天历史、模型 thinking、tool-call 参数、未引用的检索候选或模型摘要。实现位于 `pi-idea-extension/src/worker-context-assembly.js`。

## 召回与失败规则

- `inputRefs` 是硬依赖，不做 top-k 猜测；
- locator 命中后恢复完整 island；
- 任一必需 ref 缺失，返回 `missing-required-input`，不启动 worker；
- 完整依赖超过 worker token budget，返回 `required-closure-over-budget`，不截断；
- task card 引用了 tool call/thinking/bash command，返回 `forbidden-context-kind`；
- worker 不允许递归委派；需要科学判断、改假设、改 claim 或改方向时交还 Sol。

## Effort 自适应

- 短、低风险、可机械拆分：Luna low；
- 长但可拆分的机械任务：切成 <=20 分钟、<=24k input 的 low chunks，每段后做 evidence barrier；
- 依赖深、歧义高、风险高或含较多科学判断：medium/high/max；
- 仅在同类连续失败两次或未解决证据冲突时逐级升档；
- 无论 effort 如何，GPU 永远 false，并发固定 1。

## 生命周期与 UI

Workflow runtime registry 使用：`running / waiting / blocked / complete / failed`。footer 只显示 `Wn`；`/idea-workflows` 显示模型、effort、年龄和 label，peek 后显示 frozen card hash、objective、最近状态。等待用户或 blocked 必须排在 running 之前；完成结果只回传结构化 delta，不把工具 transcript 倒回主对话。

## 与主上下文的边界

主线程只接收：

- 一段结论；
- 精确 evidence refs；
- artifacts；
- 建议的 state delta（仍需用户确认或确定性 verifier）；
- 不确定性/风险。

工具线程的过程输出、搜索噪声和重复文件内容保留在自己的 raw transcript，不进入主 Sol context。这样两层 loop 才真正隔离：主 loop 保持研究判断，Workflow loop 吞掉机械上下文。
