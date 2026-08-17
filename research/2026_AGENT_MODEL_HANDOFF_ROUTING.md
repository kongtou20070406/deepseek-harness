# 2026 Agent 模型接管与路由论文笔记

更新时间：2026-08-12

## 研究问题

能否由强模型先定义任务与边界，再让廉价模型连续接管一段 Agent loop，完成后仅以摘要、证据和状态增量交还强模型，从而避免昂贵模型逐步轮询？

## 结论

可以，而且 2026 年顶会论文已经充分支持“长轨迹中按阶段或按步选择模型”这一方向。但现有证据同时反对两个极端：

- 全程只用昂贵模型：会把普通工具操作和格式处理也按最高单价执行；
- 每一步都反射式切换模型：会增加路由开销、上下文重建与 prompt-cache 损失，并可能在 handoff 中传播错误。

适合 Pi Idea Extension 的最小模式是**有边界的工作段接管**：强模型定义接管契约，廉价模型在契约内连续执行，满足完成条件后一次性交还；只有歧义、路线冲突、权限/预算临界或无法验证时才提前升级。

这不是对论文系统的直接复刻，而是根据多篇论文共同结果得到的工程推论。

## 核心论文

### 1. MTRouter: Cost-Aware Multi-Turn LLM Routing with History–Model Joint Embeddings

- 录用：ACL 2026 Main Conference，Long Paper。
- 贡献：给定交互历史与候选模型，在长轨迹的每一轮预测模型对最终任务结果的效用。
- 结果：ScienceWorld 相比 GPT-5 总成本降低 58.7% 且得分更高；HLE 成本降低 43.4% 并保持有竞争力的准确率。
- 对本项目最重要的发现：有效路由不是“切换越多越好”。成功轨迹的切换更少；频繁模型切换还会降低 prompt-cache 命中率，使新模型重新处理轨迹前缀。
- 局限：训练依赖大量离线轨迹；最长实验只有 50/30 步；其历史处理仍主要依赖 token 截断，不足以直接解决我们的长期上下文问题。
- 启发：V0 不训练 router；先使用稳定工作段和明确升级条件，并记录任务类型、模型、成本、耗时与结果，为以后学习路由积累真实数据。

来源：[ACL Anthology](https://aclanthology.org/2026.acl-long.2045/) · [PDF](https://aclanthology.org/2026.acl-long.2045.pdf)

### 2. EvoRoute: Experience-Driven Self-Routing LLM Agent Systems

- 录用：ACL 2026 Main Conference，Long Paper。
- 贡献：在 Agent Workflow 的子任务粒度，按历史相似任务、Agent 角色和预期工具选择模型，并在性能、成本、延迟之间做 Pareto 选择。
- 结果：在 GAIA 与 BrowseComp+ 上，集成进现有 Agent 系统后最高减少 80% 成本和 70% 以上延迟，同时维持或提高任务表现。
- 启发：路由记录应以“子任务/工作段”为单位，而不是保存所有对话文本；长期可以从本人的真实科研工作中学习哪些简单任务适合 Luna，哪些必须由强模型处理。
- 不直接采用：它持续追加逐步经验记录。若照搬会造成存储增长；我们只保留聚合统计、失败代表样本和可追溯来源，并设置容量上限。

来源：[ACL Anthology](https://aclanthology.org/2026.acl-long.1771/) · [PDF](https://aclanthology.org/2026.acl-long.1771.pdf)

### 3. LLM-as-Scheduler: Agentic Workflow Dynamic Scheduling

- 录用：ACL 2026 Main Conference，Long Paper。
- 贡献：用两级 cascade 动态决定 Workflow 的 early exit、验证、修复或重路由。第一级使用规则和小模型，只有非平凡情况才调用较强调度模型。
- 结果：平均 token 降低 50.5%，端到端延迟降低 36% 以上，准确率最多下降 1.4 个百分点。
- 启发：廉价模型结束工作后，不应默认唤醒强模型做完整重审。先用确定性测试、schema、产物存在性和小型 gate 判断是否满足交还条件；只有关键判断才恢复强模型。
- 风险：论文的小 gate 需要领域校准，跨科研任务泛化仍未证明。因此 V0 的 gate 应优先使用确定性完成条件和显式冲突条件，不依赖一个未经校准的置信度数字。

来源：[ACL Anthology](https://aclanthology.org/2026.acl-long.581/) · [PDF](https://aclanthology.org/2026.acl-long.581.pdf)

### 4. RAG-on-a-Diet: A Reinforcement Learning-Based Dynamic Resource Optimization Framework for RAG

- 录用：ACL 2026 Main Conference，Long Paper。
- 贡献：把多跳 RAG 的每一跳视为独立资源决策，选择足够完成当前跳的最小模型，并设置 hop 上限与置信 gate。
- 结果：HotpotQA 相比 IRCoT 推理成本降低 60.07%，F1 下降 3.7%；在相同 F1 下比 Adaptive-RAG 降低 37.30% 成本。
- 启发：每个接管租约必须同时有 loop 上限、token/时间预算、完成条件和升级条件。仅靠模型说“完成了”不足以结束任务。

来源：[ACL Anthology](https://aclanthology.org/2026.acl-long.1562/) · [PDF](https://aclanthology.org/2026.acl-long.1562.pdf)

### 5. AgentAsk: Multi-Agent Systems Need to Ask

- 录用：ACL 2026 Main Conference，Long Paper。
- 贡献：系统分析 Agent handoff 的错误传播，归纳 Data Gap、Signal Corruption、Referential Drift、Capability Gap 四类主要错误，并只在关键边上插入最小澄清。
- 结果：五个 benchmark 上准确率最高提高 4.69%，额外延迟和成本低于 10%。
- 启发：接管包必须携带明确目标、引用稳定的对象/文件/证据、能力边界与缺失信息；廉价模型发现歧义时应交还或询问，不能自行补全。交还摘要必须保留证据引用，防止主模型接收到“无来源结论”。

来源：[ACL Anthology](https://aclanthology.org/2026.acl-long.1294/) · [PDF](https://aclanthology.org/2026.acl-long.1294.pdf)

### 6. DiSRouter: Distributed Self-Routing for LLM Selections

- 录用：ICLR 2026 Poster。
- 贡献：让候选模型基于自身能力边界决定回答还是把任务路由给其他模型，而不是完全依赖一个外部小 router。
- 启发：Luna 的升级信号不应只有外部分类器；它自身也应能显式报告“不确定、超出能力、需要路线判断”。但自我置信不能单独作为安全依据，必须和确定性检查、预算与权限边界组合。

来源：[ICLR 2026](https://iclr.cc/virtual/2026/poster/10010146) · [OpenReview PDF](https://openreview.net/pdf?id=KDcwXKr0NU)

## 对 Pi Idea Extension 的直接设计结论

### 接管开始

强模型只生成一次接管包：

- 任务目标与非目标；
- 当前工作段需要的最小上下文；
- 可用工具和工作区权限；
- 完成证据与验证方式；
- loop、token、时间和失败预算；
- 必须交还控制的条件。

Scientific Idea 的权威内容仍由扩展注入并只读；廉价模型没有方向修改权。

### 接管期间

- 连续 Agent loop 由廉价模型执行，强模型不逐步轮询；
- 普通工具错误在预算内本地恢复；
- 每次 loop 只更新工作段状态，不把完整过程重新注入；
- 同一错误不得形成递归重试；
- 出现歧义、路线冲突、能力不足、权限边界或预算临界时立即交还。

### 接管结束

交还包只包含：

- 完成状态；
- 结构化结果；
- 证据与产物引用；
- 运行过的确定性验证；
- 失败和未解决风险；
- 对主上下文有意义的状态增量。

原始工具日志和廉价模型中间对话不进入强模型上下文，只保留外部可追溯索引。

### V0 不做的事

- 不训练神经 router；
- 不在每一个模型调用前额外调用一个 LLM router；
- 不根据一次工具失败立刻切换模型；
- 不允许廉价模型改变 Idea、路线或阶段目标；
- 不无限积累逐步经验、摘要或路由记录。

## 首个可证伪实验

选择 30 个真实 Pi 工作段，按任务类型分层：检索整理、批量文件检查、测试运行、简单实现、复杂实现、科研推理。

比较：

1. 全程强模型；
2. 强模型每步轮询廉价 Worker；
3. 强模型一次发放接管租约，廉价模型连续执行后交还。

固定同一任务、工具权限和完成测试，记录：成功率、昂贵模型输入/输出 token、总 token、首结果时间、总延迟、模型切换次数、上下文重建量、人工纠偏次数、方向漂移和不可恢复错误。

只有方案 3 在不降低成功率、不增加方向错误的前提下显著降低昂贵 token，才将模型接管加入正式扩展。
