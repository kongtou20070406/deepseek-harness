# 2024–2026 Agent Harness 证据地图

更新：2026-08-13

## 结论先行

目前证据支持空投提出的假设，但要用更精确的表述：

> **上下文组装可以提高模型性能，前提是它提高了有效信息密度、保留了当前任务所需的目标与冲突，并避免检索遗漏；“压缩得更短”本身不等于组装正确。**

这不是纯粹的 token 优化。正式论文分别观察到：长输入本身会降低正确率；新检索内容会造成干扰；选择性 workflow/经验注入能提高任务成功率；按子任务组织记忆在长软件任务中增益更大。它们共同支持“输入给模型什么、以何种结构和时序输入”是 Harness 的性能变量，而不只是模型外围的数据管理。

但反证同样清楚：错误或错位经验会被模型模仿并传播；提示词式 Skill Library 可以比无 Skill 更差；多 Agent 的常见增益很小且失败率很高。正确的产品方向因此不是尽量增加记忆、Skill 和 Agent，而是只在可验证地改善任务时启用它们。

## 一、上下文、记忆与压缩

### A 级：直接支持当前 Context Compiler

#### Context Length Alone Hurts LLM Performance Despite Perfect Retrieval — EMNLP 2025 Findings

[论文页](https://aclanthology.org/2025.findings-emnlp.1264/)

- 在数学、问答和代码任务的五个模型上，即使模型能完美检索相关信息，输入增长仍造成 13.9%–85% 的性能下降。
- 即使把无关 token 换成空白、mask 掉或把证据紧贴问题，下降仍存在；说明问题不完全等同于“检索不到”。
- “先复述证据再作答”的短上下文化策略在 RULER 上让 GPT-4o 最多提高约 4%。
- 对本项目的意义：Full Raw 不是理想上界；活动上下文长度本身就是需要控制的变量。P0 置顶之外，还应把本轮证据集中为短的可消费结构。
- 限制：属于 Findings，任务不等同于数周软件科研；不能据此断言任何压缩算法都优于完整历史。

#### LongLLMLingua — ACL 2024 Long

[论文页](https://aclanthology.org/2024.acl-long.91/)

- 以关键信息密度和位置为中心压缩长 prompt；NaturalQuestions 最多提高 21.4%，同时约 4 倍减少 token；10k token prompt 端到端加速 1.4–2.6 倍。
- 对本项目的意义：不能只按时间截尾；关键内容的位置和密度会影响模型。P0、当前任务与证据应该位于调用前部，并减少无关内容插入其间。
- 不直接采用：它以 token 级压缩为主。我们的代码、证据和科研决定需要块级 provenance，不能允许不可追溯的逐 token 删除。

#### Context Folding — ICML 2026 Regular

[OpenReview](https://openreview.net/forum?id=lNRgWoGfYg)

- 主轨迹保留规划责任，完成的子轨迹被 branch/fold 为紧凑结果；报告活跃上下文约为 ReAct 基线的十分之一。
- 对本项目的意义：最近未闭合轨迹保留原文；已闭合工作块可在后台折叠。摘要直接来自 raw block，不能摘要再摘要。
- 不直接采用：完整 FoldAgent runtime。Pi 已有会话树和 Agent loop，我们只吸收 fold 原子。

#### Structurally Aligned Subtask-Level Memory — ICML 2026 Regular

[OpenReview](https://openreview.net/forum?id=2CoRS45Ucj)

- 按功能子任务而非整段 episode 存储、检索与更新记忆；SWE-bench Verified 平均提高 4.7 个百分点，且任务越长收益越明显。
- 对本项目的意义：工作块边界应跟随“完成一个功能/实验/核验”，而不是固定 N 条消息；Skill 和证据也应按子任务索引。

#### Lightweight LLM Agent Memory with Small Language Models — ACL 2026 Long

[论文页](https://aclanthology.org/2026.acl-long.588/)

- STM/MTM/LTM 分层；在线阶段固定检索预算与两阶段筛选，离线阶段由小模型整合。
- 相比 A-MEM 平均约 +2.5 F1；检索中位 83 ms、端到端 581 ms。
- 对本项目的意义：Luna 只做后台、可重建的折叠；每轮在线选择应是固定预算的确定性过程，不能阻塞主对话。

#### Ontology-Guided Long-Term Agent Memory — MLSys 2026

[MLSys proceedings](https://proceedings.mlsys.org/paper_files/paper/2026/hash/2fb4be70fc9668e9ec2c71b34fb127d4-Abstract-Conference.html)

- 轻量 memory graph、对话线索增强、混合检索和预算路由；Recall@10 0.58→0.70，nDCG@10 0.41→0.51，相比 long-context 成本下降 81%。
- 对本项目的意义：当前阶段/对象可用于 query enrichment；版本、支持、反对、派生关系可作为 typed edges。
- 暂不采用完整 ontology：V0 应先证明简单块索引的失败，避免为了“图”而造图。

#### Mitigating Context Interference for Reliable and Efficient Search Agents — ACL 2026 Long

[论文页](https://aclanthology.org/2026.acl-long.160/)

- 系统研究多轮搜索的上下文干扰，发现干扰主要来自最新检索文档；提出“先精炼上下文、再生成”。
- 对本项目的意义：刚返回的工具结果不应自动享有最高保留权。它先进入 evidence candidate，经结构化提取后再进入主调用；原文保留索引供核验。

#### How Memory Management Impacts LLM Agents — ACL 2026 Long

[论文页](https://aclanthology.org/2026.acl-long.27/)

- 发现 experience-following：当前输入与检索记录越相似，输出也越倾向模仿历史执行。
- 两类主要风险是错误传播和 misaligned experience replay；即使历史轨迹表面成功，错误中间过程或分布变化也会伤害新任务。
- 使用轨迹 evaluator 的环境反馈可帮助删除低质量记忆，但论文也警告 vanilla LLM evaluator 可能比小而高质量的人工集合造成更严重负面影响。
- 对本项目的意义：记忆/Skill 默认是候选；确定性结果、未来复用表现和用户提升共同决定 admission。相似度不能替代质量检查。

### B/C 级：补充边界

- **APEX-MEM — ACL 2026 Long**：[论文页](https://aclanthology.org/2026.acl-long.749/)。append-only raw history，冲突在检索时解析。对应“原始会话是事实源；摘要和索引可重建”。
- **Prompt Compression Survey — NAACL 2025**：[论文页](https://aclanthology.org/2025.naacl-long.368/)。压缩方法与评测维度的综述，用于避免把单一 benchmark 外推为通用结论。
- **Long Context Compression Trade-offs — EMNLP 2024 Findings**：[论文页](https://aclanthology.org/2024.findings-emnlp.266/)。不同压缩目标存在权衡，不存在无条件最优策略。

## 二、可学习 Skill 与经验复用

### A 级：最值得吸收的原子

#### Agent Workflow Memory — ICML 2025

[PMLR](https://proceedings.mlr.press/v267/wang25bx.html)

- 从完成任务诱导可复用 workflow，并按当前任务选择性注入；可离线生成，也可在线从测试任务生成。
- Mind2Web 和 WebArena 的相对成功率分别提高 24.6% 与 51.1%，并减少成功任务的步骤；跨任务/网站/领域的绝对提升为 8.9–14.0 点。
- 对本项目的意义：Skill 不应是完整历史或角色提示，而应是很短的可复用动作结构；按任务检索，且有明确适用条件。

#### XSkill — ICML 2026 Regular

[OpenReview](https://openreview.net/forum?id=AjP1yvCyoG)

- 双流经验：动作级 experience 与任务级 skill；通过多路径 rollout、critique、检索适配和使用反馈持续改进。
- 对本项目的意义：区分一次性的“这次怎么修”与跨任务的“何时使用什么步骤”；只有后者才进入 toolbox。
- 迁移限制：论文流程比个人 Pi 运行时重，V0 只实现 versioned candidate、验证、使用反馈和淘汰，不实现持续自训练。

#### Generalizing Experience with Hierarchical MetaFlows — NeurIPS 2025 Main

[NeurIPS](https://proceedings.neurips.cc/paper_files/paper/2025/hash/5c882988ce5fac487974ee4f415b96a9-Abstract-Conference.html)

- 经验树节点包含静态 workflow 与动态子任务；从历史任务合并并检索最相关 MetaFlow。
- AppWorld 平均成功率 +32.3%，WorkBench +6.2%，同时降低执行成本。
- 对本项目的意义：Skill 可有“稳定骨架 + 本轮待填参数”，但不应把用户目标写入 Skill；目标仍由 P0/任务包提供。

#### Lessons Learned — NeurIPS 2025 Main

[NeurIPS](https://proceedings.neurips.cc/paper_files/paper/2025/hash/9d5d8162d91727959aa1a47e5d15dd50-Abstract-Conference.html)

- 小型代码模型在不同优化类别具有互补性；通过 lesson solicitation → banking → selection，使小模型团队超过更大模型和其他协作方法。
- 对本项目的意义：Worker 可以提交带来源的 lesson candidate；银行按任务选择，不广播给所有线程。论文不支持“每轮所有 Agent 互聊”。

#### ExpeL — AAAI 2024

[AAAI](https://ojs.aaai.org/index.php/AAAI/article/view/29936)

- 不更新模型参数，收集经验、抽取自然语言 insight、在推理时召回；表现可随经验增长。
- 对本项目的意义：个人 Harness 可以通过外部版本化 Skill 学习，而无需微调模型。

#### Voyager — TMLR 2024

[TMLR/OpenReview](https://openreview.net/forum?id=ehfRiF0R3a)

- 可执行 skill library，通过环境反馈迭代并跨世界复用。
- 对本项目的意义：Skill 最好是可执行或可验证的操作契约，而不是一段泛化建议。Minecraft 到科研软件的迁移距离较大，只采用这一原子。

#### TroVE — ICML 2024

[PMLR](https://proceedings.mlr.press/v235/wang24az.html)

- grow/use/periodically trim 可验证工具箱；报告工具箱缩小 79%–98%，人工核验快 31%、准 13%。
- 重要反证：后续 ICML 2025 AI for Math workshop 的 compute-matched 复验认为部分 MATH 收益可能来自额外推理计算，而非 toolbox 本身。它降低了我们对“只要积累工具就会变强”的信心。
- 对本项目的意义：任何 Skill benchmark 必须按总模型调用/token 匹配，不能让 Skill 条件获得更多计算。

#### LEGO-Prover — ICLR 2024

[ICLR](https://proceedings.iclr.cc/paper_files/paper/2024/hash/85dca46374dc0f27b4bb5f265b3d17f0-Abstract-Conference.html)

- 使用形式验证的 lemma library；生成技能的消融贡献约 4.9%。
- 对本项目的意义：最可靠的 Skill 是能由测试、类型、schema、proof 或固定 evaluator 验证的技能。

### 关键反证：SAGE — ACL 2026 Long

[论文页](https://aclanthology.org/2026.acl-long.69/)

- 最终 SAGE（专家 SFT + skill-aware GRPO）在 AppWorld 提高 8.9% Scenario Goal Completion，步骤少 26%，生成 token 少 59%。
- 但纯 prompting 的 Skill Library Agent 明显低于无 Skill 基线；论文自己指出 prompt-based self-improvement 有局限。
- 训练时在同一 scenario 内进行理想化 skill retrieval；最初还需要 Claude 3.5 Sonnet 生成专家轨迹，开源模型单靠提示难以生成高质量 rollout。
- 因而不能把 SAGE 的最终数字归因于“装一个 Skill Library”。对 Pi 的可迁移结论只有：Skill 必须有结果验证、使用反馈和 admission；运行时无训练条件下不能照搬其自动保存策略。

## 三、多 Agent、并行代码与强弱模型协作

### 直接支持“廉价模型是主模型的工具”

#### MINIONS — ICML 2025

[PMLR](https://proceedings.mlr.press/v267/narayan25a.html)

- 天真地让本地小模型和云端强模型来回聊天，云成本降低 30.4 倍，但只保留强模型 87% 性能。
- 强模型把长文档分成短、简单子任务，小模型在局部短上下文中并行执行后，成本降低 5.7 倍且保留 97.9% 的强模型性能。
- 失败原因正是小模型难以遵循复杂多步指令和处理长上下文。
- 对本项目的意义：Luna 收到“最小任务包 + Idea 身份引用 + 完成条件”，不携带完整主对话；多个 Luna 只处理可分离的检索、测试、批量检查或独立文件任务。

#### Unified Routing and Cascading — ICML 2025

[PMLR](https://proceedings.mlr.press/v267/dekoninck25a.html)

- 将 routing 与 cascading 放进统一优化视角；质量估计器决定何时用便宜模型、何时升级。
- 对本项目的意义：Luna-first 仅在有确定性 gate 或经校准的历史成功率时成立。无法验证的科研方向判断直接留给主模型。

### 支持有限并行，而非自由多 Agent

#### Agent-Oriented Planning — ICLR 2025

[ICLR](https://proceedings.iclr.cc/paper_files/paper/2025/hash/31610e68fe41a62e460e044216a10766-Abstract-Conference.html)

- 子任务分解的三条原则：solvability、completeness、non-redundancy；中央 meta-agent 分解、分配、评估并调整。
- 对本项目的意义：并行前先生成依赖/写集；每个任务应可由 Luna 独立完成、整体无缺口且不重复消耗。

#### AutoML-Agent — ICML 2025

[PMLR](https://proceedings.mlr.press/v267/trirat25a.html)

- 将计划分解为数据预处理、模型设计等专业子任务并行执行，再以多阶段验证引导代码生成；覆盖 7 类任务、14 个数据集。
- 对本项目的意义：只有输入、产物和验证可分离的任务才并行；并行结果先进入 staging，验证后才合并。

#### Contract-Coding — ACL 2026 Findings

[论文页](https://aclanthology.org/2026.findings-acl.400/)

- 以 Language Contract 作为 SSOT，通过模块拓扑独立性降低执行深度、实现 architectural parallelism；Greenfield-5 功能成功率 47%，结构完整性接近完美。
- 对本项目的意义：并行代码的核心不是“多开 Agent”，而是先冻结接口契约和写集边界。论文属于 Findings，且对象是 greenfield 生成，不能直接外推到已有科研仓库。

#### Multi-Agent Collaboration via Evolving Orchestration — NeurIPS 2025 Main

[NeurIPS](https://proceedings.neurips.cc/paper_files/paper/2025/hash/f1320d2e2842169c6fc89dcbd80e94d0-Abstract-Conference.html)

- 中央 orchestrator 根据状态动态安排 Agent；主要收益来自更紧凑的循环推理结构而非更多角色。
- 对本项目的意义：保持一个主对话控制者；Worker 是被调用的线程，不产生并列控制权。

#### RTADev — ACL 2025 Findings

[论文页](https://aclanthology.org/2025.findings-acl.80/)

- alignment check 后仅在需要时进行临时 group review，以较少通信改善代码可执行性和完整性。
- 对本项目的意义：Sol 审查或 Worker 研讨只在冲突、软检查点或用户授权阶段启用，不能每轮固定召开。

### 重要但不适合默认采用

- **MAGIS — NeurIPS 2024 Main**：[NeurIPS](https://proceedings.neurips.cc/paper_files/paper/2024/hash/5d1f02132ef51602adf07000ca5b6138-Abstract-Conference.html)。四角色在当时 SWE-bench 上达到 13.94%，但基线与模型已过时，不能证明角色本身优于同计算量单 Agent。
- **MetaGPT — ICLR 2024**：[ICLR](https://proceedings.iclr.cc/paper_files/paper/2024/hash/6507b115562bb0a305f1958ccc87355a-Abstract-Conference.html)。SOP 减少聊天式级联幻觉，但流水线重、并非真正并行；只吸收“结构化中间契约”。
- **GPTSwarm — ICML 2024**：[PMLR](https://proceedings.mlr.press/v235/zhuge24a.html)。把 Agent 表示为信息流图并优化节点/边，适合离线 Harness 实验表示，不适合在线自改。
- **Mixture-of-Agents — ICLR 2025**：[ICLR](https://proceedings.iclr.cc/paper_files/paper/2025/hash/5434be94e82c54327bb9dcaf7fca52b6-Abstract-Conference.html)。层间全量读取所有输出，benchmark 强但 token 与上下文开销高，不适合默认工作线程。
- **Dynamic MoA — ICLR 2025**：[ICLR](https://proceedings.iclr.cc/paper_files/paper/2025/hash/a5554e55d7a21e62d0d7a028ec0ea1c7-Abstract-Conference.html)。不同任务需要不同的 diversity/consistency 权衡，支持“条件式研讨”，而非永久 ensemble。

### 多 Agent 的强反证

#### Why Do Multi-Agent LLM Systems Fail? — NeurIPS 2025 Datasets & Benchmarks

[NeurIPS](https://proceedings.neurips.cc/paper_files/paper/2025/hash/b1041e52d3be19f0a9bc491657488e4a-Abstract-Datasets_and_Benchmarks_Track.html)

- 1,642 条轨迹、7 个框架，观察到 41%–86.7% 的失败率；论文明确指出流行 benchmark 上的多 Agent 增益经常很小。
- 14 种失败集中于系统设计（44.2%）、Agent 间错位（32.3%）和任务验证（23.5%）。高频问题包括违反任务规格、步骤重复、丢失历史、未意识到终止条件、任务偏移、信息隐瞒、忽略其他 Agent、推理/动作不一致，以及缺失/错误验证。
- 把最终决定权交给 CEO 的一次结构调整使 ChatDev case study 成功率 +9.4%，但作者强调孤立修补不足以解决整体可靠性。
- 对本项目的意义：一个主控制者、最小任务包、显式终止条件、结构化结果、确定性验证与不共享完整对话不是风格偏好，而是直接针对已观察失败模式。

## 四、Harness 结构、评测与安全

### Interface 与状态

- **SWE-agent — NeurIPS 2024 Main**：[NeurIPS](https://proceedings.neurips.cc/paper_files/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html)。定制 Agent–Computer Interface 显著改变代码导航、编辑和测试表现；说明工具接口和结果呈现本身是模型性能变量。
- **OpenHands Software Agent SDK — MLSys 2026**：[MLSys](https://mlsys.org/virtual/2026/poster/3526)。不可变配置、event-sourced state、无状态/可替换组件与 lifecycle control 支持我们把权威事件和派生缓存分开。
- **AgentSquare — ICLR 2025**：[ICLR](https://proceedings.iclr.cc/paper_files/paper/2025/hash/0ae94013da7cd459402fd77874e09ee3-Abstract-Conference.html)。统一 Planning/Reasoning/Tool/Memory IO，模块搜索平均超过手工设计 17.2%。可用于离线、可回滚 Harness 实验；生产运行时不得自动修改自己。
- **AFlow — ICLR 2025**：[ICLR](https://proceedings.iclr.cc/paper_files/paper/2025/hash/5492ecbce4439401798dcd2c90be94cd-Abstract-Conference.html)。MCTS 搜索代码化 workflow，平均 +5.7%，特定任务小模型以 GPT-4o 4.55% 推理成本超过它。搜索成本和过拟合风险使它只适合离线 benchmark。
- **Automated Design of Agentic Systems — ICLR 2025**：[ICLR](https://proceedings.iclr.cc/paper_files/paper/2025/hash/36b7acf6f6010652b3f2a433774a66fe-Abstract-Conference.html)。自动生成 Agent 代码有潜力，但“ever-growing archive”与在线自修改违反当前可控性目标；仅保留 proposal/eval/rollback 原子。

### 结果验证

- **τ-bench — ICLR 2025**：[ICLR](https://proceedings.iclr.cc/paper_files/paper/2025/hash/1b126cc38b8638e07bef37e7b2bb72bf-Abstract-Conference.html)。以最终数据库状态确定性评分，并用 pass^k 测一致性；GPT-4o 低于 50%，retail pass^8 低于 25%。说明一次成功不足以证明 Harness 稳定。
- **AgentBoard — NeurIPS 2024 D&B**：过程进度指标与人工判断高度相关。对本项目采用 stage progress/soft checkpoint，但最终正确性仍由产物状态判定。
- **AgentIssue-Bench — NeurIPS 2025**：修复 Agent 系统本身仍极难，提醒我们用真实 Pi 回归而非只在合成 prompt 上自证。

### 安全边界

- **ToolEmu — ICLR 2024**：[ICLR](https://proceedings.iclr.cc/paper_files/paper/2024/hash/7274ed909a312d4d869cc328ad1c5f04-Abstract-Conference.html)。LM-emulated sandbox 可扩展地发现高风险行为；68.8% 的模拟失败可成为真实失败，最安全被测 Agent 仍有 23.9% 风险失败。
- **AgentDojo — NeurIPS 2024 D&B**：[NeurIPS](https://proceedings.neurips.cc/paper_files/paper/2024/hash/97091a5177d8dc64b1da8bf3e1f6fb54-Abstract-Datasets_and_Benchmarks_Track.html)。97 个任务、629 个安全 case；外部工具返回的不可信文本会劫持 Agent。
- 对本项目的意义：Worker 结果和网页/文件内容都是不可信证据，不是新指令；工作区外写入和破坏性操作需要边界，但无需把普通只读/工作区内操作全部流程化。

## 五、对 Pi Idea Extension 的采用决策

### 立即保留/强化

1. P0 逐字置顶、独立版本、派生记忆无修改权。
2. 最近未闭合原始轨迹 + 已完成工作块摘要 + 任务相关证据/冲突。
3. 在线固定预算的确定性检索；Luna 后台单并发折叠。
4. raw event log 是事实源；摘要、索引、Skill 和路由统计都可重建或回滚。
5. Context Manifest 记录每次实际注入的来源、版本、哈希和 token。
6. Skill 只作为 candidate；有适用条件、验证、失败记录、版本和淘汰机制。
7. Worker 只接最小任务包，结果作为新增证据/产物，不覆盖主对话和 Idea。
8. 并行由依赖图和写集决定；接口未冻结或共享写集时回退单执行者。
9. 确定性 gate 优先；只在冲突或无法验证时调用更强审查。

### 实验后再决定

- 语义 embedding/reranker 是否比当前 BM25/CJK bigram 带来真实任务增益；
- typed evidence graph 是否改善隐式关联召回；
- Luna 工作段接管在实际 Pi 编码中能否保持成功率；
- Skill 自动 proposal 是否比人工保存带来净收益；
- 并发 Luna 对独立文件任务的墙钟收益是否覆盖额外 token 与合并成本；
- 离线模块搜索是否值得维护。

### 明确不做默认能力

- 全量历史永远注入；
- 摘要递归摘要和无限积累；
- 未验证经验自动写入正式 Skill；
- 每轮所有 Agent 互聊或共享实时全局上下文；
- 让多个主对话并列改方向；
- 在线自修改 Harness/Skill 后直接投入生产；
- 用更多 Agent 调用掩盖同计算量基线不足；
- 用模型自评替代可获得的测试、状态、hash 与证据引用。

## 六、中心假设的可证伪预测

若当前 Context Compiler 确实提高模型性能，应同时观察到：

1. 在早期证据、后来否决和同名干扰共同存在时，方向/冲突题正确率高于 Tail 和 Global Summary。
2. 在完整历史仍未超过模型窗口时，也能高于或不劣于 Full Raw；否则它只解决容量，不提高推理性能。
3. 在短任务和“全文每段都相关”的任务上，Full Raw 可能相等或更好；编译器应能识别或至少公开这一失败域。
4. 检索漏掉唯一关键反证时，Structured Assembly 会明显失败；Manifest 必须让这一遗漏可诊断。
5. 相同 Luna 总 token 下，经验证 Skill 应优于无 Skill；未经验证或错位 Skill 应暴露负迁移，而非被平均成绩隐藏。
6. 并行只在无共享写集任务上缩短墙钟时间；共享文件任务应出现冲突并触发回退。

后续 benchmark 只要推翻其中关键预测，就必须修改组装器，而不是解释为模型“没配合”。

## 七、已完成的 Luna 先导证伪

2026-08-13 使用 `gpt-5.6-luna` 对 8 条约 58.6k-token、64-turn 的合成长轨迹进行了 7 条件对照。完整记录见 `HARNESS_PERFORMANCE_BENCHMARK_2026-08-13.md`。

- 原实现只有 7/8 正确，证据召回 50%；在版本化决定任务中把用户确认的 `0.37` 错成较新的旧配置 `0.42`。因此“原 Context Compiler 已提高性能”被否证。
- 把 P0 作为只读检索锚点后恢复 8/8；将 fold unit 调整为 4.8k–7.2k tokens 后仍为 8/8，证据召回提高到 87.5%，平均活跃上下文为 4,740 tokens。
- Full Raw 也是 8/8、召回 100%，但平均活跃上下文为 59,259 tokens。当前组装器用约 8.0% 的上下文达到相同的先导决策正确率，但尚未达到相同证据召回。
- 单次快照下，Global Summary + Tail 为 8/8、召回 100%、平均 2,166 tokens，不能被忽略。它的长期问题是每次更新需要重新读取增长中的全历史、provenance 较弱、容易形成摘要递归；这些是工程推断，尚需多事件序列 benchmark 验证。
- `n=8` 无法支持显著性或普适性结论；延迟也受服务波动影响。现阶段只足以接受两项低风险修改：P0 query enrichment 与较大不可变 raw-rooted fold unit。
