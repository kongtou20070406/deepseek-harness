# 长期科研对话上下文与记忆：论文调研

更新时间：2026-08-12

研究问题：怎样在持续数周或数月的科研主对话中，用有限上下文稳定保存科学方向、证据、冲突、实验操作和开放任务，同时降低主模型 token、等待时间与方向漂移？

## 结论先行

现有研究共同支持“短工作集 + 分段/分层摘要 + 可回溯原文”，而不支持把最大窗口持续塞满。对本 Harness 最合适的 V0 不是另造一个 Luna 记忆系统，而是保留 P0/P1 作为外部权威状态，在 Pi 原生递归 compaction 内加入语义块，并把原始 JSONL/文件作为可追溯事实源。

## 直接相关论文

| 工作 | 核心机制 | 对 Harness 的可用启发 | 不能直接照搬的部分 |
|---|---|---|---|
| [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) | 把上下文视为分层内存，通过显式迁移管理有限窗口 | P0/P1 类似固定工作集，旧会话是慢存储 | 完整“内存操作系统”对本项目过重 |
| [A Human-Inspired Reading Agent with Gist Memory of Very Long Contexts](https://arxiv.org/abs/2402.09727) | 模型决定 episode 边界，压成 gist，必要时回看原文；报告有效上下文扩展 3.5–20 倍 | 语义块应有边界、gist 和原文指针；实验操作可压成复现索引 | 论文面向长文阅读，不直接解决多月科研状态更新 |
| [RAPTOR](https://proceedings.iclr.cc/paper_files/paper/2024/hash/8a2acd174940dbca361a6398a4f9df91-Abstract-Conference.html) | 对块递归聚类与摘要，构建多抽象层检索树 | 原生 summary 应递归更新，不应不断叠加平铺摘要 | 当前 V0 不需要树检索和 embedding 基础设施 |
| [Generative Agents](https://arxiv.org/abs/2304.03442) | 完整经验流、反思、规划与动态检索 | 观察、反思、计划应是不同记忆语义，不应混写 | “可信角色行为”不等于科学正确性，其重要性评分不能控制 Idea |
| [LongMemEval](https://arxiv.org/abs/2410.10813) | 评估信息抽取、跨会话推理、时间推理、知识更新和拒答；比较 session/segment/turn 粒度 | 块粒度、时间和知识更新必须进入未来评测；不能只测“还记不记得” | 基准主要是聊天事实，不覆盖科学路线漂移 |
| [LoCoMo](https://arxiv.org/abs/2402.17753) | 最高约 35 sessions 的长程对话，覆盖 QA、事件摘要和时间/因果动态 | 未来应增加跨 session、事件摘要和因果冲突测试 | 平均约 9k token，仍短于真实数月科研项目 |
| [MemoryBank](https://arxiv.org/abs/2305.10250) | 按时间与重要性更新/遗忘记忆 | 非权威操作细节可以衰减，关键反证需强化 | “遗忘曲线”是启发式，不能自动遗忘科学反证 |
| [A-MEM](https://arxiv.org/abs/2502.12110) | 受 Zettelkasten 启发的动态索引、链接与记忆演化 | 证据块将来可以建立来源链接与冲突边 | 由 Agent 改写旧记忆会违反本项目的权威状态边界 |
| [Mem0](https://arxiv.org/abs/2504.19413) | 动态抽取、合并、检索显著信息，并研究 graph memory | 抽取/合并能节省 token 与延迟；块索引应独立于正文 | 论文/系统结果与其 benchmark 实现仍需独立复现，不作为选型定论 |
| [ReSum](https://arxiv.org/abs/2509.13313) | 长程搜索中周期性把交互轨迹变成紧凑推理状态 | 周期整理应发生在任务进行中，而不是溢出后；摘要要服务开放任务 | 该工作针对搜索 Agent，且使用专门训练；本项目先用原生模型摘要 |
| [Agentic Memory / AgeMem](https://arxiv.org/abs/2601.01885) | 把 store/retrieve/update/summarize/discard 作为可学习策略动作 | 长期可研究统一的块生命周期策略 | 需要训练与奖励设计；让主 Agent 自主 discard 会增加方向风险 |
| [LLMLingua](https://arxiv.org/abs/2310.05736) / [LongLLMLingua](https://arxiv.org/abs/2310.06839) | 粗到细的 prompt/token 压缩与位置感知压缩 | 说明 token 级压缩可进一步降成本 | token 删除可能损坏 P0 精确文本和科研细节，因此不用于权威层 |

## 为什么不能等到窗口快满

[Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) 发现模型利用长上下文时存在明显位置敏感性，相关信息位于中部时性能可能显著下降。[RULER](https://arxiv.org/abs/2404.06654) 在检索、多跳追踪和聚合任务上发现，许多模型的有效上下文能力明显小于标称窗口。两者都支持“保持上下文稀疏、把权威信息放前部、把最新任务放尾部”，而不是以填满 272k 为目标。

## 从论文到当前实现的映射

- MemGPT 的分层内存 → P0/P1 与 Pi session 历史分离。
- ReadAgent 的 episode/gist/original → 六类语义块、Pi summary、JSONL/文件指针。
- RAPTOR/ReSum 的递归与周期摘要 → Pi 原生 previous-summary compaction + 40% 软阈值。
- LongMemEval 的粒度与更新 → 六块独立哈希和未来的跨会话评测。
- A-MEM 的链接思想 → 当前只保留来源指针；不允许 Agent 自动改权威 Idea。
- Lost in the Middle/RULER → P0 固定在首部，不追求把标称窗口用满。

## 证据限制

1. 多数论文评测的是问答、陪伴、长文或网页搜索，不是“数月科研路线不漂移”；迁移到本项目属于工程推断。
2. 2025–2026 的 A-MEM、Mem0、ReSum、AgeMem 中部分结果来自预印本或作者自建评测，不能把排行榜数字直接当成稳定事实。
3. 现有 benchmark 很少测“压缩后仍能区分事实、假设和反证”。本项目必须自己增加这种测试。
4. 当前 40% 软阈值、20k recent tail、4500 token summary 和 8 代索引是保守初值，不是论文证明的全局最优参数。

## 建议评测

1. **P0 稳定性**：十次以上原生递归 compaction、退出恢复、分支后逐字一致。
2. **块保真度**：事实不得升级自假设；冲突/反证 recall；操作块能否复现实验。
3. **更新能力**：新证据否决旧假设时，旧假设应标为否决而非消失。
4. **方向漂移**：给出大量工具工程噪声，终点标准与科学对象仍应主导下一步。
5. **效率**：主模型输入 token、compaction token、首 token 延迟、后台 CPU 时间、SQLite/JSONL 月增长量。
6. **消融**：完整历史、Pi 默认临界压缩、40% 原生分块压缩三组对照。
