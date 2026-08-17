# Pi Idea Harness 开发约束

本仓库开发一个基于 Pi 扩展机制的轻量个人科研 Harness。服务对象始终是研究者确认的 Scientific Idea；模型、线程、Workflow、代码与工具都只是推进 Idea 的手段。

## 不变量

1. 每次主对话和授权 Sol 调用，输入消息最前方必须逐字包含用户已确认的 Idea Kernel。Kernel 只承载科学对象、成功条件与禁止偷换项；当前路线属于 Research Frame 或 Working State。

2. Idea Kernel 不参与摘要、检索或压缩。Research Frame 只能由模型提议、用户确认；Working State 可由模型填充但不是科学决策。
3. Idea 只能通过“提案 → 精确 diff → 用户确认 → 新的不可变版本”改变。普通文件编辑工具不得直接修改 `IDEA.md`。
4. 讨论、模型建议、实验结果和压缩摘要都不能自动成为权威 Idea。
5. 一个 Idea 同一时间只有一个主对话控制者。其他对话只能追加证据或提案；接管必须由用户显式触发。
6. 工程工作不能替代科学目标。若局部优化不再推进科学对象或终点标准，应暴露冲突，而不是继续造工具。
7. 强约束 Idea 边界，弱约束科研过程。除防止方向漂移或不可恢复错误外，不新增强制步骤。

## V0 开发边界

- 在 `earendil-works/pi` 上以 Pi package/extension 实现，不 fork Pi 核心。
- 保留 Pi 原生对话、会话树、分支、恢复和模型登录体验。
- 使用 Idea Space 内的 `IDEA.md`、`.harness/state.sqlite`、`evidence/` 和 `artifacts/`。
- 使用 Pi `context` 事件注入 Idea Kernel、Research Frame 和当前任务所需 Working State；每次实际注入保存可检查的 Manifest、来源、预算与哈希。
- 主界面保持普通 Pi 对话，只增加轻量状态行；Idea、上下文与版本细节放在按需二级界面。
- V0 先证明 Idea 在长对话、压缩、退出、恢复和分支后仍不偏移。Luna、Sol、完整 Workflow 与 Obelisk 集成随后增量加入。

## 实现规则

- 优先最小纵向闭环和确定性代码，不用额外 Agent 流程代替可编程检查。
- 初始化时只让用户自然语言描述想法；AI 可整理自由格式候选，但涉及方向的歧义必须询问用户，且只有用户在二级界面确认后才可生成权威 P0。
- Kernel、Frame 与当前 Working State 合计不得超过有效输入预算的 1/20；超过时停止并提示复盘，绝不静默截断权威层。
- 重要状态采用追加事件和版本记录；任何缓存都不是事实源。
- 测试至少覆盖：精确注入、十次模拟压缩、检索缺失、预算压力、未确认提案不能提交、旧版本可追溯、直接写入被阻止。
- 依赖保持少且固定版本；不得在日志、Idea 状态或上下文清单中保存凭据。
