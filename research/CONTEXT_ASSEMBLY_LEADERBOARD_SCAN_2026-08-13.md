# 上下文分割与组装：公开结果、开源实现与下一步

更新：2026-08-13

## 结论先行

不存在一个可以直接照抄的“统一排行榜第一”。不同项目使用不同数据子集、回答模型、裁判、上下文预算与延迟口径。当前可核验结果应分成三组：

1. **LongMemEval-V2 官方准确率—延迟前沿。** 官方基线中，AgentRunbook-C 在 Small/Medium 上为 74.9%/70.1%，查询延迟 108.3/139.9 秒；AgentRunbook-R 为 58.6%/57.0%，延迟 26.9/25.8 秒；普通 RAG 只有 0.1–0.3 秒，但准确率 38.1%–51.0%。官方因此使用 LAFS 衡量准确率—延迟前沿，而不是只按准确率排序。[LongMemEval-V2 官方页面](https://xiaowu0162.github.io/longmemeval-v2/)；[官方代码](https://github.com/xiaowu0162/LongMemEval-V2)
2. **旧 LongMemEval-S 的最高公开自报。** `agentmemory` 报告 481/500，即 96.2%，并在官方仓库 issue 中公开结果文件；但回答模型是 Claude Opus 4.6、裁判是 GPT-4o，结果尚不是统一模型条件下的同行评审排行榜。因此它可作为工程线索，不能作为我们与它的纯检索层横向比较。[项目仓库](https://github.com/JordanMcCann/agentmemory)；[LongMemEval issue #29](https://github.com/xiaowu0162/LongMemEval/issues/29)
3. **统一条件下的开源横评。** ProsusAI MemEval 固定模型、embedding、裁判与成本核算；其 102 题 LongMemEval 子集上 PropMem 的 judge accuracy 为 0.716，优于 SimpleMem 0.667、OpenClaw 0.598 和 Full Context 0.520。这个结果说明“实体过滤的原子事实”有效，但 preference 子集仍只有 0.147，远未解决隐含偏好。[MemEval](https://github.com/ProsusAI/MemEval)

对 Pi Idea Harness 的直接判断是：**不复制任何整套系统；吸收其有效原子，并在相同回答模型、相同裁判和配对样本下逐项验证。**

## 我们当前的公开基准位置

正式锁定的 LongMemEval-S 分层 60 题结果：

| 条件 | 正确率 | 平均注入上下文 | 组装中位数 | 组装 P95 |
|---|---:|---:|---:|---:|
| 纯本地原文 passage | 44/60，73.33% | 7,056 tokens | 104.1 ms | 129.9 ms |
| Luna grounded claims + 原文融合 | 46/60，76.67% | 8,693 tokens | 107.3 ms | 118.4 ms |

配对差值为 local − Luna = −3.33 个百分点，95% bootstrap 区间为 [−10.0, +3.33] 个百分点；discordant pairs 为 local-only 1、Luna-only 3。样本达到预登记的最低 60，但仍不能宣布统计等价、非劣或明确赢家。

分类型暴露出最重要的问题：两条路径在 `single-session-preference` 都是 0/6。Luna 在 knowledge-update、multi-session 和 single-session-user 各多答对 1 题，却在 temporal-reasoning 少答对 1 题。这支持“结构化标签可能提升正确率”的方向性证据，但不构成定论。

结果文件：`research/benchmarks/longmemeval/results/longmemeval-2026-08-13T01-54-29-708Z.json`。

## 高分系统真正做了什么

### 1. AgentRunbook：把经验拆成多种可检索对象

LongMemEval-V2 的 AgentRunbook-R 不只检索一个摘要池，而是分别维护 raw state、event 和 strategy note；查询时生成多路查询，再分别取证。AgentRunbook-C 把轨迹与摘要保存为文件，让 coding agent 借助 manifest 和检查脚本主动寻找证据。[论文](https://arxiv.org/abs/2605.12493)；[代码](https://github.com/xiaowu0162/LongMemEval-V2)

可吸收：多表示、明确 provenance、辅助检查工具。

不吸收：在每个问题上启动 coding-agent 检索。它提高准确率，但百秒级查询不符合 Pi 对话的交互要求。

### 2. LiCoMemory：分层结构、时间与原文同时存在

LiCoMemory 使用 session summary、实体关系层和原始 dialogue chunk 的三层 CogniGraph，并保留层间 provenance。其 GPT-4o-mini LongMemEval 设置报告 73.8% accuracy、约 1.7k tokens、1.74 秒查询。消融中，去掉结构后为 51.6%，去掉时间后为 57.2%，去掉摘要后为 61.4%。论文还观察到 top-k 太大时准确率下降，并选择 k=15。[ACL Findings 2026 论文](https://aclanthology.org/2026.findings-acl.1835/)

可吸收：摘要/结构/原文分层；时间是独立字段；固定小候选集；结构只用于索引与 provenance。

不直接吸收：完整知识图谱。另一项 ACL 2026 统一研究表明，在 LongMemEval-S 上图和扁平检索延迟接近 45/44 ms，但在更大 LongMemEval-M 上变为 574/240 ms；图的收益也依赖回答模型和 value 组织方式，不是无条件成立。[Does Memory Need Graphs?](https://aclanthology.org/2026.acl-long.1232/)

### 3. agentmemory：多信号融合与确定性工程

`agentmemory` 的公开实现组合 lexical、dense、temporal、graph、importance 与 activation，并使用 cross-encoder rerank。更值得借鉴的是其确定性修复：内容哈希决定 HNSW 层级、固定 Python hash seed、固定裁判 seed，避免检索噪声掩盖真实改进。[agentmemory](https://github.com/JordanMcCann/agentmemory)

可吸收：信号分开计算、固定融合、按题型调整预算、可复现实验。

暂不吸收：HNSW 与向量作为生产必需项。其 96.2% 同时受 Opus 4.6 回答能力影响；必须先在相同 Luna 回答模型上做消融，才知道向量与 cross-encoder 是否提供净增益。

### 4. PropMem：实体过滤比整段语义搜索更稳

PropMem 把记忆拆成原子 propositions，按实体过滤后再推理。在统一 MemEval 设置中，它同时取得 LongMemEval 子集最高 judge accuracy 和更好的质量—成本权衡。[MemEval](https://github.com/ProsusAI/MemEval)

可吸收：实体/标识符作为第一阶段硬过滤与覆盖检查。

局限：它的 preference 得分仍很低，说明原子事实和实体匹配解决不了“语义不相似但认知相关”的线索。

### 5. LoCoMo-Plus：偏好失败不是简单召回失败

LoCoMo-Plus 专门测试 cue–trigger semantic disconnect：早期线索表达用户状态、目标或价值，后续问题不复用相同表面词汇。论文指出普通 string matching 和显式题型提示都与这种任务不匹配。[ACL 2026 论文](https://aclanthology.org/2026.acl-long.1150/)

这与我们 preference 0/6 高度一致。当前标签更像“事实摘要”，没有把“未来什么问题或行动会需要这条信息”变成可检索 cue。

### 6. Chain-of-Memory：组织方式比盲目扩大 top-k 更重要

Chain-of-Memory 把命中的片段组织为有上下文关系的 memory chains；论文报告 top-k 增大后收益饱和，噪声反而可能伤害推理。[ACL 2026 论文](https://aclanthology.org/2026.acl-long.534/)

可吸收：命中后做确定性邻接、时间链和同实体链扩展；不把互不相关的 top-k 平铺进 prompt。

## 下一版：提高正确率同时降低在线延迟

### 离线/后台：让 Luna 生成检索表示，不参与在线选取

每个稳定工作块只处理一次，输出下列派生字段；所有字段必须回指不可变 raw block：

- grounded claim：可逐字 quote 校验的事实；
- retrieval cues：这条信息未来可能以哪些不同措辞、行为后果或隐含约束被需要；
- entities/identifiers：人、项目、文件、实验、变量、对象；
- temporal provenance：session date、event time、相对时间及解析置信度；
- authority/status：user-confirmed、observed、assistant-proposed、superseded、contradicted；
- typed links：supports、contradicts、updates、derived-from、same-entity。

Luna 只生成索引材料，不能改 P0、不能决定路线、不能生成最终答案。内容哈希命中时不重复生成；失败不会阻塞主 Agent。

### 在线：本地确定性检索，不再等待模型

1. 从当前任务中提取词项、标识符、日期表达和局部任务形态；不读取 benchmark 标签。
2. 使用 SQLite FTS5/BM25F 分字段检索 `cue / claim / entity / raw`，而不是当前简单 set-IDF。
3. 用固定权重或 reciprocal-rank fusion 合并 lexical、entity、time、authority 四类排名。
4. 在候选上做覆盖检查：问题实体是否覆盖、日期是否随 claim 注入、update 是否同时看到新旧冲突、multi-session 是否跨 session、preference 是否命中 cue。
5. 覆盖不足时只做本地自适应扩展：邻接 clause、同 session、同实体、时间前后项、冲突项。
6. 注入时按 `最短指导摘要 → grounded claims → 必要逐字 raw excerpts` 排列。摘要不能替代原文；我们未完成的 claims-only 消融已经出现早期错误，因此不允许 claims-only 成为生产默认。

### 标签可以是不透明的多通道检索码

标签的消费者是上下文组装器，不是人或主模型，因此在线表示不必保存为可读摘要。原型将检索信息分成多组 64-bit hex labels：`L` 原文词项/字符 n-gram、`C` Luna retrieval cue、`E` 实体/标识符、`T` 时间、`A` authority/status、`R` 邻接/更新/冲突关系。每个 code 的 posting list 只指向 grounded claim 或 raw passage；命中后注入的仍是逐字原文、日期与 provenance。

关键做法是：Luna 可在后台生成可读 cue，但程序立即将 cue 规范化并变成 opaque feature codes。在线查询把用户 prompt 变成同类 codes，直接查 posting lists；不扫描全部 claim 文本，也不把 cue 本身送进主模型。由此 retrieval cue 可以跨越偏好的词汇断裂，同时不增加注入 tokens。

60 题、相同 top-8 的无 cue 原型结果：单块建码中位 0.92 ms、P95 1.53 ms、最大 21.46 ms；查询中位 0.24 ms、P95 0.43 ms。证据 session recall 为 72.8%，当前文本选择器为 69.9%；但至少命中一个证据为 81.7% 对 83.3%，preference 为 4/6 对 5/6。它证明了速度和压缩可行，但未证明任务成功率提升，因此尚未接入生产。实现与测试位于 `research/benchmarks/compact-hex-index.mjs`。

### 预算不是固定 top-k，而是有界自适应

从 2.5k tokens 开始，覆盖不足再扩到 5k，最后到 7.5k/当前硬上限。只有覆盖门通过后才停止。这样比无条件注入约 8.7k 更可能降低 token，同时保留难题所需证据。

### 延迟目标

- 新块在不依赖 Luna 的情况下完成本地分割、hash、字段提取与持久化后，单块 **P95 < 1 秒**，工程目标 **P95 < 250 ms**；
- 每次 Agent loop 从索引查询、融合、覆盖扩展到上下文组装完成，**P95 < 2 秒**，工程目标 **P95 < 250 ms**；
- 冷启动索引重放、单块增量写入、热查询分别报告，不允许用热缓存均值掩盖冷启动或长尾；
- Luna cue/tag 生成全部在 settle 后后台执行，在线等待固定为 0；
- FTS 索引增量更新，查询复用 prepared statement；
- query 结果按 `(P0 hash, P1 hash, task hash, index generation)` 短期缓存；
- 先检索 30–50 个候选，再压到约 15 个证据单元；
- cross-encoder 只作为可选实验，不进入默认路径，除非同模型配对评测显著增分且 P95 可接受；
- 生产队列保持单并发/小 pending；基准测试的 64 个 Pi 进程曾占约 8.4 GB，已判定不可作为生产并发策略。

## 如何证明改进有效

所有改动采用同一 Luna 回答模型、同一裁判、相同 60/500 个配对问题和相同随机顺序；每次只改变一个组件。

实验顺序：

1. 当前 Luna fusion 基线；
2. `+ retrieval cues`，优先观察 preference 与 LoCoMo-Plus；
3. `+ opaque multi-channel posting index / BM25F`；
4. `+ temporal/update coverage gate`；
5. `+ adaptive 2.5k→5k→7.5k budget`；
6. 可选 `+ local cross-encoder rerank`。

每一步必须同时通过延迟门。若正确率提高但查询 P95 超过 2 秒，该机制不得进入默认每-loop 路径，只能降级为后台或显式深检索模式。现有 60 题基线的完整组装 P95 为 118–130 ms，说明硬门有充分余量，但新 SQLite/FTS 实现仍须独立测量增量写入、查询和冷启动。

选择仍使用字典序：任务正确率第一；正确率统计相当才比较注入 tokens；前两项相当才比较组装中位数/P95。任何省 token 但明显掉正确率的方案直接淘汰。

除 LongMemEval-S 外必须增加两类压力：

- LongMemEval-V2：同时报告 accuracy 与 query latency/LAFS，不只报告 recall；
- LoCoMo-Plus：专门验证隐含偏好、目标和约束，防止我们只优化显式事实题。

## 明确不做

- 不把“图”当成自动正确性的来源；图只限制索引、遍历与 provenance。
- 不让 Luna 标签成为权威事实；raw event 永远是事实源。
- 不在每个 loop 运行检索 Agent、向量服务或 cross-encoder。
- 不用更强回答模型制造检索层的虚假提升。
- 不为了排行榜堆功能；只吸收在同条件消融中提升任务成功率或在正确率相当时降低 tokens/延迟的机制。

## 为未来多层 Agent loop 预留的上下文协议

层级按责任和上下文范围划分，不按模型数量划分：

1. **Idea loop**：唯一方向控制者，携带完整逐字 P0，批准 task、解释证据与判断是否推进科学对象。
2. **Task loop**：接收最小任务包、非目标、相关证据、完成条件和 Idea/路线 hash；可以执行复杂实现，但不能改 Idea。
3. **Worker loop**：Luna 或本地模型执行检索、重排、测试、转换、轮询等窄任务；只返回结构化结果和 provenance。
4. **Tool loop**：确定性程序完成索引、覆盖检查、状态读取和终止判断；能不用模型就不用模型。

每个下层 loop 只允许追加 evidence/proposal，不能覆盖父层状态；都必须记录 `loop_id`、`parent_loop_id`、`scope`、`input_manifest_hash`、预算、停止原因和 `result_manifest_hash`。同一个失败不得递归创建同类型子 loop；重试有硬上限。V0 不实现多 Agent 调度，但上下文与 manifest 数据结构不得阻碍后续增加这些层。
