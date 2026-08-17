# AI 记忆与上下文组装：论文笔记与 Harness 设计启示

> 状态：工作文档 v0.2
> 日期：2026-08-11
> 用途：为基于 Pi 的科研 Harness 设计索引、滚动压缩与上下文组装层提供参考。
> 范围：定向文献扫描，补充覆盖数周至数月的长期任务恢复、目标漂移诊断与程序性 Skill；不是系统综述。
> 研究说明：本文由 AI 辅助检索与归纳，优先链接论文原文或正式论文页；2025–2026 年预印本结论均按未充分复现的系统证据处理。

## 1. 当前已经确定的 Harness 约束

主对话和经授权的 Sol 审查线程，每次模型调用都必须在最前面逐字携带：

```text
科学对象 + 终点标准 + 当前路线版本
```

该固定方向前缀不参与检索、Luna 选择或滚动压缩。动态区可以随任务增长，并定期压缩为带原始来源的追加式压缩块。最近的“用户 ↔ 主对话”交流优先逐字保留；工具过程、Workflow 中间状态和较旧历史可以压缩。

Luna 负责廉价的检索、压缩、相关性选择和简单工作线程；主对话负责推理、实现、推进和派活。并行 Workflow 追加结果而不覆盖共享状态；互相冲突的证据同时保留。与当前阶段或路线相关的未解决冲突属于强制上下文。

## 2. Obelisk 可以借鉴什么

当前 [Obelisk](https://github.com/tommy0103/obelisk) 已原生索引 Pi JSONL v1–v3，并理解 Pi 的会话树、分支、压缩、保留尾部、自定义消息、工具调用和 token 用量。它适合作为默认安装但可拔插的历史证据 sidecar，其分层是：

1. 原始会话、消息、工具调用、工具结果、Workflow 和线程记录是证据层。
2. SQLite 保存结构化关系，FTS5 提供轻量全文索引。
3. 压缩记忆只是检索入口，不替代原始记录。
4. 每条记忆保留来源 session/message 范围，可回到原文核验。
5. 检索先按项目、会话、文件、时间和内容类型缩小范围，再做文本搜索。

可直接复用的是 Pi/Claude/Codex 历史索引与查询接口；可借鉴的是“原始记录 + 结构化索引 + 压缩检索面 + 来源追踪”。Obelisk 仍不是 Harness 的事实源：Idea、路线、P1、证据采纳状态、上下文包版本与预算保存在 Idea Space，Obelisk 只返回候选历史证据。

本机参考：`C:\Users\27363\.agents\skills\obelisk\SKILL.md` 与 `references/schema.md`。

## 3. 论文扫描

### 3.1 MemGPT：把上下文看成分层虚拟内存

论文：[MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)（Packer et al., 2023，预印本）

- **WHY**：有限上下文窗口难以支撑长文档分析和跨会话交互。
- **HOW**：借鉴操作系统的分层内存与虚拟内存，在不同记忆层之间移动信息，并通过中断管理控制流。
- **WHAT**：论文在长文档分析和多会话聊天任务上验证了这种分层上下文管理思路。[论文原文](https://arxiv.org/abs/2310.08560)

对 Harness 的启示：

- 固定方向前缀相当于永不换出的 pinned memory。
- 最近直接对话相当于 working set。
- Obelisk 式原始历史和压缩块相当于 archival memory。
- 上下文组装器相当于 pager，但换入依据应是当前阶段问题，而不是让主模型自由决定一切。

不能直接照搬：MemGPT 强调 Agent 自主管理记忆；我们的核心方向前缀、路线版本和冲突保护不能交给模型自主换出。

### 3.2 RAPTOR：递归摘要形成多层索引

论文：[RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval](https://proceedings.iclr.cc/paper_files/paper/2024/hash/8a2acd174940dbca361a6398a4f9df91-Abstract-Conference.html)（Sarthi et al., ICLR 2024）

- **WHY**：只检索短而连续的文本块，容易丢失跨片段的整体关系。
- **HOW**：对文本块递归执行 embedding、聚类和摘要，形成从细节到高层概括的树；查询时可以从不同抽象层取回信息。
- **WHAT**：论文报告递归摘要检索在多个长文档问答任务上优于传统扁平检索，并在 QuALITY 的一个设置中报告了明显提升。[ICLR 论文页](https://proceedings.iclr.cc/paper_files/paper/2024/hash/8a2acd174940dbca361a6398a4f9df91-Abstract-Conference.html)

对 Harness 的启示：

- 追加式压缩块可以自然形成层级，而不是维护一份不断覆盖的总摘要。
- 检索时可以先返回“阶段摘要”，再按需展开到任务、回合和原始消息。
- 多个 Workflow 可以共享高层压缩块，同时按自己的任务读取不同叶节点。

不能直接照搬：递归摘要会累积语义误差。每个压缩节点必须保留子节点与原始消息范围；固定方向前缀、关键反证和未解决冲突不得进入递归摘要链。

### 3.3 LongLLMLingua：查询相关的上下文压缩

论文：[LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression](https://aclanthology.org/2024.acl-long.91/)（Jiang et al., ACL 2024）

- **WHY**：长上下文同时带来计算成本、性能下降和位置偏差；关键信息的密度与位置会影响模型表现。
- **HOW**：根据当前问题进行粗到细的 prompt compression，并重新组织保留内容，使关键部分更容易被读取。
- **WHAT**：论文在其评测设置中报告了 token、延迟和任务表现上的收益；这些数字来自 GPT-3.5-Turbo 和特定问答基准，不能直接外推到 Pi + GPT-5.6。[ACL 论文页](https://aclanthology.org/2024.acl-long.91/)

对 Harness 的启示：

- Luna 的选择必须以当前阶段问题和当前任务为 query，而不是做通用摘要。
- 不只是“找到了什么”，还要控制注入顺序：固定方向前缀最前，当前任务和决定性证据靠前，背景材料靠后。
- 每次上下文重组都应有明确 token 预算。

不能直接照搬：token 级删除可能破坏公式、代码、否定词和实验条件。第一版更适合做“结构块选择与摘要”，不做激进的 token 级压缩。

### 3.4 LongMemEval：把记忆拆成 indexing、retrieval、reading

论文：[LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813)（Wu et al., ICLR 2025）

- **WHY**：长上下文模型和商业聊天系统在持续交互中仍会出现明显的长期记忆性能下降。
- **HOW**：用信息提取、跨会话推理、时间推理、知识更新和拒答五类能力评测长期记忆，并把系统拆成 indexing、retrieval、reading 三阶段及 value、key、query、reading strategy 四个控制点。
- **WHAT**：论文发现，把整段 session 拆成较细的 round 往往有利于检索；过度压成孤立事实会损失细节。多 key 索引、时间感知 query expansion 和结构化读取均能改善其评测结果。[论文原文](https://arxiv.org/abs/2410.10813)

对 Harness 的启示：

- 索引基本单元不应只是完整会话，也不应只是脱离上下文的事实；“一个用户—主对话回合”或“一个结构化事件”更合适。
- 一个压缩块应有多个检索 key：摘要、关键词、阶段、路线版本、时间、文件、证据类型和关联主张。
- 检索命中不等于主模型能正确使用；最终上下文必须结构化呈现来源、时间、状态和相互关系。
- 未来评测不能只测 Recall@k，还要测知识更新、冲突保留、时间推理和应当拒答时是否拒答。

### 3.5 A-MEM：原子笔记、动态链接与记忆演化

论文：[A-MEM: Agentic Memory for LLM Agents](https://papers.neurips.cc/paper_files/paper/2025/file/19909c36f51abc4856b4560aff3d36d6-Paper-Conference.pdf)（Xu et al., NeurIPS 2025）

- **WHY**：固定的存储结构和预设读写流程难以适应不同长期任务。
- **HOW**：借鉴 Zettelkasten，为新记忆生成上下文描述、关键词和标签，并与历史记忆建立动态链接；新记忆还可触发既有记忆表示的演化。
- **WHAT**：论文在 LoCoMo、DialSim 和多个基础模型上报告了多跳、时间和对话记忆方面的提升，并给出了 token 效率分析。[NeurIPS 论文](https://papers.neurips.cc/paper_files/paper/2025/file/19909c36f51abc4856b4560aff3d36d6-Paper-Conference.pdf)

对 Harness 的启示：

- 压缩块适合做成原子、可链接的 Context Capsule。
- 可以维护 `supports`、`contradicts`、`derived_from`、`supersedes`、`same_stage` 等少量关系。
- Luna 可以生成候选标签和链接，帮助跨 Workflow 共享上下文。

不能直接照搬：A-MEM 允许新记忆更新既有记忆的表示；这与我们的追加式、不可静默覆盖原则冲突。我们只借鉴“原子笔记 + 链接”，既有块本身保持不可变，变化通过新版本或新关系表示。

### 3.6 Zep：时间关系与历史状态

论文：[Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)（Rasmussen et al., 2025，预印本）

- **WHY**：静态 RAG 难以处理持续变化的对话与结构化数据。
- **HOW**：使用具有时间意识的知识图谱整合非结构化对话和结构化数据，同时保留历史关系。
- **WHAT**：论文在 DMR 和 LongMemEval 上报告了相对基线的性能和延迟收益；它是预印本且与具体产品架构紧密相关，结果应视为有价值但仍需独立复现的系统证据。[论文原文](https://arxiv.org/abs/2501.13956)

对 Harness 的启示：

- Idea、路线和阶段都应具有 `valid_from`、`valid_to` 或明确版本边界。
- “旧结论”不应被删除，而应标明它在哪个版本和证据条件下有效。
- 冲突不是覆盖关系，而应成为显式边。

不能直接照搬：完整 temporal knowledge graph 对第一版过重。V1 只需要版本链和少量关系边，不需要通用实体抽取或图数据库。

### 3.7 最新实证提醒：错误经验会被模型继续模仿

论文：[How Memory Management Impacts LLM Agents: An Empirical Study of Experience-Following Behavior](https://aclanthology.org/2026.acl-long.27.pdf)（Xiong et al., ACL 2026）

- **WHY**：Agent 的记忆库会不断加入自身产生的轨迹，其中不可避免地包含噪声和错误。
- **HOW**：研究 memory addition/deletion 对多个 Agent 长期行为的影响，分析输入相似度与后续执行相似度之间的关系。
- **WHAT**：论文观察到 experience-following：相似任务检索到某条历史轨迹后，Agent 容易产生相似输出；错误轨迹可能传播，表面相关但不适用的经验也可能误导后续执行。论文强调记忆质量评价的重要性，并发现无限增长并非必要。[ACL 2026 论文](https://aclanthology.org/2026.acl-long.27.pdf)

对 Harness 的启示：

- Workflow 成功执行不等于它的过程值得作为未来示范。
- 原始记录可以永久保留，但进入“推荐注入池”必须有证据质量和适用范围标记。
- 失败、冲突和错误不能删除；应降低其作为正向示范的权重，同时保留为反证或风险记录。
- Luna 不能只按语义相似度选历史，还要考虑结果质量、阶段匹配和是否已被反证。

## 4. 综合结论：适合我们的最小记忆模型

### 4.1 四层结构

```text
L0  固定方向状态
    科学对象 + 终点标准 + 当前路线版本
    不压缩、不检索选择；主对话和 Sol 每次完整携带

L1  当前工作集
    当前阶段、当前任务、相关未解决冲突、最近直接对话原文

L2  Context Capsules
    追加式压缩块、结构化证据、决定、失败、Workflow 结果
    每项带来源范围、时间、路线/阶段版本和关系边

L3  Raw Archive
    完整消息、工具调用、日志、文件和 Workflow 局部过程
    永久可追溯，默认不注入模型
```

这是对 MemGPT 分层思想、RAPTOR 多层摘要、LongMemEval 多 key 检索、A-MEM 原子链接和 Obelisk 原始证据索引的轻量组合。该组合是针对本 Harness 约束做出的设计推论，不是任何一篇论文直接提出的架构。

### 4.2 Context Capsule 的最小字段

```text
id
kind                 # evidence | decision | hypothesis | conflict | failure | result | summary
text
source_refs[]        # message / tool result / file / experiment / workflow
idea_version
route_version
stage_id
created_at
validity             # active | superseded | disputed | resolved
relations[]          # supports | contradicts | derived_from | supersedes
quality              # unknown | weak | moderate | strong
```

检索字段可额外生成，但不改写 Capsule 正文：

```text
keywords[]
entities[]
task_types[]
time_range
embedding             # 后续可选，不是 V1 必需
```

### 4.3 建议的检索与组装顺序

```text
1. 读取固定方向前缀
2. 确定当前 Stage / Task / Workflow scope
3. 强制加入相关未解决冲突与当前必要证据
4. 用结构化字段和 FTS5 做候选召回
5. Luna 在 token 预算内重排并选择候选块
6. 加入最近直接对话原文和新产生的结构化结果
7. 输出带来源引用的 Model Context Packet
```

V1 优先使用 SQLite + FTS5 和确定性 scope filter。只有在真实检索失败表明词法索引不足时，再增加 embedding；不应一开始就建设完整向量库或知识图谱。

## 5. 明确不做的事情

- 不让 Luna 修改固定方向前缀。
- 不维护一份反复覆盖、无法追溯的总摘要。
- 不让并行 Workflow 覆盖彼此结果。
- 不把矛盾证据自动合并成共识。
- 不因某条失败经验无用就删除原始证据。
- 不默认把相似历史当成正确示范。
- V1 不做通用知识图谱、复杂记忆强化学习或激进 token 级压缩。

## 6. 后续实现前需要验证的问题

1. Pi 的 session/context/tool/compaction 事件映射到 Idea Event Log 后，能否在恢复、分支和异常退出场景中保持完整。
2. 固定版本的 Obelisk CLI sidecar 在 Windows、Pi 自定义 session 目录和并发索引场景下是否稳定；Harness 降级运行是否无损于 Idea State。
3. Luna 对 Context Capsule 的压缩和相关性选择，在中文科研对话、代码、公式与实验日志上是否稳定。
4. 如何定义冲突检测的候选召回，而不让 Luna 自动裁决冲突。
5. 固定方向前缀在 OpenAI 会员订阅接入路径中能否获得稳定的 prompt caching 或等价复用。
6. 滚动压缩的软阈值、硬阈值和最近原文窗口应如何设置。

## 7. 当前建议

最值得立即借鉴的不是某个完整框架，而是四个局部机制：

1. **Obelisk**：原始历史与结构化全文索引。
2. **LongMemEval**：round/event 粒度、多 key、时间感知检索和 reading 分离。
3. **RAPTOR**：带来源的层级压缩块。
4. **A-MEM / Zep**：少量显式关系与版本/时间边界，但拒绝原地覆盖。

MemGPT 提供整体分层隐喻，LongLLMLingua 提供 query-aware compression 原则，ACL 2026 的经验研究则提醒我们：历史记录必须经过质量与适用范围判断后，才能作为未来执行示范。

## 8. 面向数周至数月科研任务的补充扫描

### 8.1 先区分三个容易混淆的概念

[The Horizon Gap](https://arxiv.org/abs/2608.06663)（Chen et al., 2026，预印本）区分了：

- **long-horizon**：任务本身需要很多相互依赖的步骤；
- **long-context**：模型一次能够接收多少 token；
- **long-term memory**：系统能否跨步骤、会话和时间持续保存并恢复状态。

这一区分对本项目很重要。科研持续数月的问题不等于“需要一个更大的上下文窗口”。即使窗口足够大，任务仍可能因为旧决定丢失、完成状态误判和目标漂移而失败。该论文综述范围很大，但截至本文更新时间仅是刚发布的 v1，适合作为问题地图，不应单独作为架构有效性的证明。

### 8.2 Plans Don't Persist：计划不能被假定已经内化

论文：[Plans Don't Persist: Why Context Management Is Load Bearing for LLM Agents](https://arxiv.org/abs/2606.22953)（Mehta & Datta, 2026，预印本）

- **WHY**：长任务会不断压缩、摘要和淘汰旧 token；早期计划恰恰最容易先被淘汰。
- **HOW**：使用 replay pairing 比较保留计划与移除计划的相同轨迹，并进行压缩压力测试。
- **WHAT**：在论文所测模型和任务中，计划信号很快衰减；直接淘汰计划使 ALFWorld 成功率下降 34.7 个百分点。作者同时明确指出，保护计划本身仍不足以解决全部长期可靠性问题。

对 Harness 的启示：

- P0 必须是每次调用重新读取的外部状态，不能假设主模型“已经记住”。
- P1 中仍会影响行动的阶段约束也必须显式恢复。
- 该结果没有直接测试 GPT-5.6 或我们的科研任务，因此它支持“不要依赖模型内隐持续状态”，但不能替代本项目自己的回放实验。

### 8.3 LongHorizon-Harness：执行历史与持久任务状态应分离

论文：[LongHorizon-Harness: Advancing Long-Horizon Agents for Real-World Tasks](https://arxiv.org/abs/2608.01964)（Ma et al., 2026，预印本）

- **WHY**：执行、任务状态维护和完成判断若都塞在同一个增长上下文中，错误的自我判断会成为后续步骤的前提。
- **HOW**：把任务状态放到执行上下文之外，只用独立环境审查得到的事实推进状态；执行轨迹完成后不继续常驻。
- **WHAT**：论文在 WeaveBench、Terminal-Bench 2.1 和 OSWorld 2.0 上报告了跨模型收益。

适合借鉴：

- Idea Space 应是模型之外的持久状态源；执行轨迹不是状态本身。
- 实验“已完成”、指标“已提升”之类的事实应尽量由产物、日志或测试验证，而不是只接受 Agent 自报。
- Luna 工作线程结束后只向主对话返回结果、证据和状态变化，局部轨迹留在归档层。

不能直接照搬：论文使用固定的 Manage–Execute–Audit 循环和 fresh-context executor。我们的主对话需要连续、自然且由人领导，不能把每个科研动作强制切成三段式流程。只有会进入 P1、改变路线判断或声明阶段成果的事实才需要更强验证。

### 8.4 Git Context Controller：版本化上下文有利于恢复与分支

论文：[Git Context Controller: Manage the Context of LLM-based Agents like Git](https://arxiv.org/abs/2508.00031)（Wu et al., 2025/2026，预印本 v3）

- **WHY**：无限增长的交互历史难以跨会话复用，也难以隔离不同探索路线。
- **HOW**：把上下文组织成持久文件系统，并提供 COMMIT、BRANCH、MERGE、CONTEXT 操作。
- **WHAT**：论文在 SWE-Bench 和 BrowseComp 设置中报告了性能收益，并展示里程碑恢复与多轨迹协作。

对 Harness 的启示：

- Idea、路线、P1 和 Context Packet 都应拥有稳定版本与父版本。
- Pi 原生 Session tree 可以继续承载对话分支；Idea Space 只增加科学语义和唯一主控制者。
- 分支结果应先作为 proposal/evidence 追加，不能自动 MERGE 到当前路线。

不能直接照搬：不需要把科研对话变成用户必须手工执行 COMMIT/BRANCH 的流程。版本事件应由 Harness 在实质变化时自动生成，只有方向变更和真实冲突才打断用户。

### 8.5 Context-Folding：折叠局部轨迹，而不是反复总结全局

论文：[Scaling Long-Horizon LLM Agent via Context-Folding](https://arxiv.org/abs/2510.11967)（Sun et al., 2025，预印本）

- **WHY**：线性保留全部 ReAct 轨迹会耗尽上下文；滚动总摘要又容易逐轮损失细节。
- **HOW**：Agent 为子任务建立局部分支，完成后将中间过程折叠成结果，再返回主轨迹。
- **WHAT**：论文在 Deep Research 和 SWE 设置中报告，32K active context 的 folding agent 可优于普通摘要方法，并显著减少活跃上下文。

这直接支持“工作线程是主对话的工具”：Luna 线程可以保留完整原始轨迹，但回到主对话时只提交结构化结果、来源和未解决问题。我们的折叠由 Harness 确定性执行，不要求模型通过强化学习自行决定哪些全局状态可以删除；P0、P1 和反面证据不参与 folding。

### 8.6 MemOps 与 LoCoMo-Plus：长期记忆不能只测事实问答

[MemOps](https://arxiv.org/abs/2607.12893)（Hao et al., 2026，预印本）把长期记忆视为 remember、forget、update、reflect 等显式状态操作，并为每次操作记录 trigger、target、scope、state transition 和 supporting evidence。论文指出，最终答案正确可能掩盖使用了陈旧值或错误更新目标等内部错误。

[LoCoMo-Plus](https://aclanthology.org/2026.acl-long.1150/)（Li et al., ACL 2026）进一步测试隐含目标、偏好和约束在长对话中的一致应用，而不是只测试能否回忆一个事实。

对 Harness 的评测启示：

- 不只测“能否找回某条历史”，还要测它是否应用了当前有效版本。
- 必须构造“旧路线已被修正”“相似但属于另一 Idea”“关键约束很早出现但后来未重复”等回放案例。
- 核心指标应包括方向一致性、状态更新正确性、冲突保留、陈旧信息拒用和证据可追溯性。

### 8.7 长上下文本身不是保险

[Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/)（Liu et al., TACL 2024）显示，模型使用长输入中部信息的能力可能显著弱于信息位于开头或结尾时。[Context Length Alone Hurts LLM Performance Despite Perfect Retrieval](https://aclanthology.org/2025.findings-emnlp.1264/)（Findings of EMNLP 2025）进一步报告，即使已提供正确检索结果，增加无关上下文长度本身仍可能降低任务表现。

这支持我们限制 P0+P1 不超过有效上下文的 1/20，并让 P0 固定置顶。剩余窗口也不应追求填满，而应按当前决策瓶颈选择最少充分证据。

## 9. 数月级任务需要的最小恢复机制

长期连续性不应依赖一份不断扩张的聊天摘要，而应依赖三个独立对象：

```text
Durable State       Idea、路线、当前有效状态和冲突
Evidence Archive    原始对话、实验、文件、日志与来源
Derived Context     针对某次模型调用临时编译的上下文包
```

每次重新进入 Idea 时，Harness 自动生成一个轻量 Re-entry Packet：

```text
P0（逐字）
当前最小 P1
上次已验证的阶段/任务结果
仍未解决的冲突与反面证据
当前等待回答的科学问题
相关证据引用和上下文包版本
```

Re-entry Packet 是从 Idea Space 派生的缓存，不是新的事实源。它在进入 Idea、路线/阶段实质变化、新证据进入或压缩前更新；普通对话轮次不要求写总结，也不弹出检查表。

## 10. 动态科研 Skill：作为程序性记忆，而不是 Idea 记忆

### 10.1 文献依据

[Cognitive Architectures for Language Agents](https://arxiv.org/abs/2309.02427)（Sumers et al., TMLR 2024）把 working、episodic、semantic 和 procedural memory 放在不同模块中。这个区分适合我们的边界：

```text
Pi 当前调用上下文          working memory
Idea Space / Obelisk       Idea-specific episodic + semantic evidence
动态科研 Skill             reusable procedural memory
```

[Voyager](https://arxiv.org/abs/2305.16291) 使用可检索的可执行代码 Skill library，并根据环境反馈、执行错误和自验证改进程序。[Agent Workflow Memory](https://arxiv.org/abs/2409.07429) 从成功轨迹中归纳可复用 workflow，并按任务选择性提供。[ExpeL](https://arxiv.org/abs/2308.10144) 则从过去经验抽取自然语言 insight，在新任务中按需召回。

这些工作共同支持“把反复使用的方法从对话历史中提炼为按需加载的程序性知识”。但它们不能证明自动提炼出的 Skill 一定正确；已有经验跟随研究也表明，错误轨迹可能通过相似检索传播。因此候选 Skill 不能因为一次成功就静默进入全局工具库。

### 10.2 Pi 原生机制与建议结构

Pi 的 [Skills 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)明确采用 progressive disclosure：启动时只把 Skill 的名称和 description 放入系统提示，任务匹配后才读取完整 `SKILL.md`；也支持全局、项目目录、package 和 CLI 指定的 Skill 来源。这与“按需触发、节省主模型 token”完全一致。

不建议维护一个不断膨胀的巨型 `SKILL.md`。第一版更适合一个很薄的路由 Skill 加按需资源：

```text
research-toolbox/
├─ SKILL.md              # 很短：触发边界、检索方式、安全规则
├─ catalog.yaml          # 工具/方法元数据、版本、适用范围、验证状态
├─ scripts/              # 可直接执行的确定性工具
└─ references/           # 仅在相关任务触发时读取的方法说明
```

Skill 中可以保存：论文抓取与核验、实验启动/监控、指标解析、统计检验、绘图、复现实验检查、远程作业诊断等可跨 Idea 复用的方法和脚本。

Skill 中禁止保存：某个 Idea 的 P0/P1、路线、实验结论、未解决冲突、用户与主对话历史、凭据明文。Workspace Binding 仍只决定这些工具能操作哪些路径或远程环境。

### 10.3 动态演化但不污染其他 Idea

建议使用轻量生命周期，而不是强制科研流程：

```text
candidate -> tested -> active -> deprecated
```

- 新方法先作为当前 Idea 的候选工具，不自动跨 Idea 生效。
- 可执行脚本至少完成一次实际测试，并记录环境与结果；这是对持久可执行能力的必要安全约束。
- 提升为全局 active Skill 时生成版本和变更 Diff。
- Workflow 捕获启动时的 Skill 版本，运行中升级不改变其语义。
- 失败或过时的 Skill 不删除历史，只停止自动召回并记录适用边界。
- 主对话可以主动调用 Skill；Luna 也可提出候选，但不能自行把候选提升为全局 active。

这一结构把 Skill 当作可复用工具箱，而不是新的管理中心。它按需出现，不强迫主对话采用固定研究流程。

## 11. 本轮检索形成的设计结论

1. 数周至数月的科研连续性必须来自 Idea Space 的外部持久状态，不能来自模型隐含记忆或单一滚动摘要。
2. P0 每次重新注入的要求得到直接实证支持；P1 应只保留当前仍有决策影响的最小工作集。
3. 执行轨迹、持久状态和完成判断要分离，但不必强制所有科研行为经过固定审计流水线。
4. Luna 线程适合采用 context folding：保留原始证据，向主对话折叠成结构化结果。
5. 长期评测必须加入目标/约束一致性、版本更新、冲突保留和陈旧状态拒用，而不只是 Recall@k。
6. 动态科研 Skill 是合理的 procedural-memory 层；Pi 已原生支持按需加载，但应使用薄路由、按需资源和版本化提升，避免巨型常驻 Skill。
7. 文献普遍只验证小时级轨迹、合成长对话或特定 benchmark。对“真实科研持续数月”的可靠性证据仍然不足，因此我们必须用自己的长期回放与真实 Idea 试运行验证，而不能把任何单篇论文的结果直接外推到 Harness。
