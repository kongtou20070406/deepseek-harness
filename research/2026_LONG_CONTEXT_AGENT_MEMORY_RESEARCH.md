# 2026 长上下文 Agent Memory 调研与采用决策

更新：2026-08-13

这份文档只回答一个问题：哪些已发表机制能实际提高 Pi 长任务的正确性、token 效率与响应速度。论文中的完整 Agent 架构不自动成为产品需求。

## 结论

最合适的不是“大知识图谱 + 多 Agent 流水线”，而是：一个保留全局责任的主模型、不可变原始历史、逐字权威 P0、按完成工作块生成的派生摘要、固定在线检索预算，以及后台廉价模型折叠。在线路径必须确定性且便宜；Luna 只做可失败、可重建的后台工作。

## 正式发表、直接影响当前实现的工作

### LightMem — ACL 2026 Long Paper

[Lightweight LLM Agent Memory with Small Language Models](https://aclanthology.org/2026.acl-long.588/)

- 论文机制：STM 保存即时上下文，MTM 保存可复用交互摘要，LTM 做离线整合；在线检索使用固定预算与两阶段选择，昂贵整理移出在线路径。
- 论文结果：相对 A-MEM 平均约 +2.5 F1；检索中位延迟 83 ms，端到端 581 ms。
- 我们采用：最近原始轮次、工作块摘要、后台 Luna 折叠、固定检索预算、确定性在线选择。
- 我们没有采用：每轮调用 Luna 重排。当前 Luna 延迟以秒计，不适合阻塞每次主调用。

### Context Folding — ICML 2026 Regular

[Context Folding](https://openreview.net/forum?id=lNRgWoGfYg)；[参考代码 FoldAgent](https://github.com/sunnweiwei/FoldAgent)

- 论文机制：把已经完成的子轨迹 branch/fold 成紧凑结果，让主轨迹保留规划责任。
- 报告结果：活跃上下文可比 ReAct 基线小约一个数量级，并保持或提高任务表现。
- 我们采用：按完整 user→assistant/tool turn 分块；一个摘要永远直接来自原始块，禁止“摘要再摘要”。
- 我们没有采用：复制其完整 Agent runtime。Pi 已经提供会话树与 Agent loop。

### Structurally Aligned Subtask-Level Memory — ICML 2026 Regular

[论文页面](https://openreview.net/forum?id=2CoRS45Ucj)

- 论文机制：记忆的存储、检索与更新粒度应对齐功能子任务，而不是整段 episode。
- 报告结果：SWE-bench Verified 平均提升 4.7 个百分点，收益随任务步数增长。
- 我们采用：以稳定工作块而不是整段会话作为折叠单位；块由完整 turn 组成，工具结果不会脱离所属任务轮次。

### Ontology-Guided Long-Term Agent Memory — MLSys 2026

[官方 proceedings](https://proceedings.mlsys.org/paper_files/paper/2026/hash/2fb4be70fc9668e9ec2c71b34fb127d4-Abstract-Conference.html)

- 论文机制：轻量 memory graph、query enrichment、混合检索、预算路由。
- 报告结果：Recall@10 0.58→0.70，nDCG@10 0.41→0.51，相比 long-context 成本下降 81%。
- 我们采用：当前问题 + 当前阶段共同形成检索查询；严格预算路由。
- 暂不采用：完整 ontology/graph。V0 的会话块哈希、来源和版本已经足够验证闭环；先证明图确实带来召回增益再增加。

### APEX-MEM — ACL 2026 Long Paper

[APEX-MEM](https://aclanthology.org/2026.acl-long.749/)

- 论文机制：append-only 原始时间历史；冲突与演化在检索时处理；输出紧凑的相关记忆。
- 报告结果：LOCOMO 88.88%，LongMemEval 86.2%。
- 我们采用：Pi 当前分支的原始消息始终是事实源；摘要、索引、缓存都是可丢弃派生物。即使 Pi 手动 compact，编译器仍从当前分支的原始 message entries 重建候选块。

### How Memory Management Impacts LLM Agents — ACL 2026 Long Paper

[论文页面](https://aclanthology.org/2026.acl-long.27/)

- 发现：Agent 会“经验跟随”；错误经验会传播，看似成功但错位的经验也会误导后续任务。
- 我们采用：执行经验先是 candidate，只有用户显式 promote 后才可注入；最多检索 3 条；Skill 永远不能改变 Idea、权限或科研方向。

### Mitigating Context Interference — ACL 2026 Long Paper

[论文页面](https://aclanthology.org/2026.acl-long.160/)

- 发现：多轮搜索中的最新检索文档也会造成明显干扰；应先精炼上下文再生成。
- 我们采用：完整工具输出不长期常驻活跃上下文；完成块折叠时保留结论、限定条件、冲突和标识符，去掉重复日志。

### Beyond Single-shot Writing — ACL 2026 Long Paper

[论文页面](https://aclanthology.org/2026.acl-long.609/)

- 论文指出多轮修订会回归已有内容和引用。
- 我们采用：P0 只能走“候选 → 精确查看 → 用户确认 → 新不可变版本”；摘要、讨论、工具和 Skill 均无权修改 P0。

## 作为工程参考、不当作同行评审证据

- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)：多 Agent 适合可并行、上下文可分离的任务；共享上下文或强依赖任务并不适合。它也报告多 Agent token 消耗显著更高。因此当前只保留单主控制者与窄 Worker 任务包，不安装通用多 Agent 框架。
- [OpenHands Software Agent SDK — MLSys 2026](https://mlsys.org/virtual/2026/poster/3526)：不可变配置、事件状态与可替换组件支持我们的追加状态设计。

## 被否决的截图材料

截图标题为 “How We Built Our Multi-Agent Research System: Centralized Reasoning with Deterministic Signals and a Knowledge-Graph Control Plane”。截至 2026-08-13：

- 未在 arXiv、OpenReview、MLSys 2026 proceedings 或 Stanford 官方页面找到可追溯记录；
- 标题前半与 Anthropic 2025 工程博客高度重合，但作者、机构、架构主张和量化指标不匹配；
- 截图中的作者、实验指标和特有短语均无可核验来源。

因此它应标为“不可验证、高概率合成或拼接材料”，禁止作为论文引用。不能据此声称知识图谱能阻止任意推理；图最多约束检索空间和 provenance，不能保证推理正确。

## 当前采用矩阵

| 机制 | 状态 | 原因 |
|---|---|---|
| P0 逐字置顶、独立于 memory | 已实现 | 科研方向不能受摘要误差影响 |
| 最近原始轮次 + 稳定块摘要 | 已实现 | 对应 STM/MTM 与 context folding |
| Luna 后台单并发折叠 | 已实现 | 便宜模型换取主模型 token；不阻塞主对话 |
| 固定在线检索预算 | 已实现 | 控制延迟与 token；避免上下文无限增长 |
| 摘要直接来自原始块 | 已实现 | 防止递归摘要误差积累 |
| 原文核验时回取 raw block | 已实现 | 摘要不是证据源 |
| 追加状态与版本哈希 | 已实现 | 可追溯、可恢复、无静默覆盖 |
| Skill 候选/人工提升 | 已实现 | 防止错误经验传播 |
| 向量检索 + 语义 rerank | 暂缓 | 当前规模确定性 BM25/CJK bigram 已足够快；先用真实失败证明需要 embedding |
| 完整知识图谱 | 否决 V0 | 结构和维护成本尚无本项目增益证据 |
| 每轮 Luna 在线选择 | 否决 | 实测秒级，破坏无感体验 |
| 多 Agent 流水线 | 否决 | token 高、责任分散、与共享 Scientific Idea 冲突 |
