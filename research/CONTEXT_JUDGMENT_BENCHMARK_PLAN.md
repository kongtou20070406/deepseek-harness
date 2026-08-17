# Context Judgment Benchmark Plan

状态：下一阶段主实验；优先级高于继续优化索引微秒数

## 问题

LongMemEval 主要回答“长期历史中是否取回了可回答问题的事实”。它不足以验证科研 Harness 更关键的能力：在多个目标、相似实体、冲突版本和分散约束同时存在时，能否判断哪些证据对当前任务真正有效，并用更少上下文完成正确判断。

## Benchmark 组合

评测不再使用一个总分混合所有能力。分成两层：

1. **产品主榜：任务是否真正完成**，用于决定生产方案；
2. **判断诊断榜：为什么完成或失败**，区分漏召回、选错证据、证据权威判断错误、更新链断裂和拿到证据后仍推理失败。

### 产品主榜：MemoryArena

- 来源：ICML 2026（PMLR 306）正式论文，数据与任务环境可下载；共 701 个带环境反馈的任务，平均约 6.9 个相互依赖的子任务。
- 场景：捆绑购物、带偏好与群体约束的旅行规划、渐进式信息搜索、数学/物理形式推理。
- 核心：后续任务故意缺少一部分信息；只有把早先行动结果、失败反馈和约束整理成可用记忆，才能完成后续动作。
- 主指标：Task Success Rate；辅以 Progress Score、总注入 tokens、总模型 tokens、组装 P50/P95 和端到端延迟。
- 意义：它测的是 `历史证据 -> 当前判断 -> 实际动作 -> 环境结果`，而不是只测检索命中。

MemoryArena 应成为生产方案的最终裁决基准。CAME-Bench 仍是上下文选择器的核心训练/诊断场，但不能单独决定“这个 Harness 是否真的更好用”。

### 端到端证据效用：τ-Knowledge

- 来源：ICML 2026 正式论文；97 个长程任务、698 篇相互关联文档、51 个需要从自然语言政策中发现和正确调用的工具。
- 每题平均涉及约 18.6 篇文档和 9.52 次工具调用，最终用后端状态验证 `pass^k`，而不是让模型自评“回答看起来不错”。
- 它回答更严格的问题：被选中的证据能否约束工具参数、动作顺序和状态变更，从而完成合规任务。gold-document recall 只作故障解释。
- 与 MemoryArena 互补：MemoryArena 更接近“跨任务经验/反馈形成记忆”，τ-Knowledge 更接近“从大量规则证据中选出真正约束当前行动的部分”。两者任一 Task Success 明显下降都不能进入生产。

### 有效证据选择：GaRAGe

- 来源：ACL Findings 2025；2,366 个问题、35,351 段人工标注 grounding，包含时间敏感、多跳、私有/公开来源和 427 个应拒答问题。
- 人工标签区分 `ANSWER-THE-QUESTION`、`RELATED-INFORMATION`、`UNKNOWN` 与无关段落，因此会直接惩罚“主题相似但不改变当前判断”的上下文污染。
- 对 Pi 的主用途不是复刻其生成榜，而是给候选选择器设门槛：在固定预算内提高 eligibility/answer-bearing precision，同时不损害最终回答正确率与应拒答率。
- 数据为 CC-BY-NC-4.0，只用于本项目研究评测；若未来商业发布 benchmark artifacts，必须重新审查许可。

### 判断诊断主基准：CAME-Bench

- 来源：ACL Findings 2026，373 个 free-response questions；Travel Planning 与 Debate 两域。
- 长度：Small 约 23k、Medium 约 137k、Large 约 408k tokens。
- 干扰：交错目标、重复实体、隐式指代、延迟解决，不保证轮流对话。
- 类型：增量修订、上下文相关事实召回、上下文相关多跳、信息综合。
- 主指标：官方 answer-set Macro-F1/Accuracy；同时记录最终任务成功率、Precision/Recall、注入 tokens 和组装 P95。
- 公平预算：遵守官方默认 retrieval context hard cap 4,096 tokens；不得用更大上下文换正确率。

这应成为 Idea Harness 上下文选择器的主诊断 benchmark，因为它直接测量“同样相关的历史中，哪一段属于当前目标”。

### 证据权威诊断：MemSyco-Bench

- 1,550 个公开样本，五种 memory-decision relation：Objective Fact Judgment、Contextual Scope Control、Memory-Evidence Conflict、Valid Memory Selection、Personalized Memory Use。
- 它不奖励“总是使用历史”或“总是忽略历史”，而是判断记忆在当前问题中究竟有没有决策权。
- 对 Idea Harness 最关键的两项是：旧偏好/旧路线不能压过更强的新证据；但当前问题确实需要个性化或 Idea 约束时又必须正确使用它。
- 记录 `retrieved-and-correct / retrieved-but-wrong / missing-and-wrong`，把组装错误与主模型判断错误分开。

### 复杂更新链诊断：RECON

- 24 个 50k--100k token case files，覆盖刑事、医疗和金融叙事。
- 测试多跳证据链、级联失效、来源冲突、反事实、时间约束与时间事实检索。
- 特别适合验证 `supersedes / contradicts / supports / derived_from`：某证据被否定后，不仅要找到新事实，还要撤销所有只依赖旧事实的下游结论，同时保留有独立支持的结论。
- 当前是 2026 年预印本，因此只作高难诊断，不与已正式发表的 CAME-Bench 混报证据等级。

### 隐式状态失效诊断：STALE

- 400 个专家复核的冲突场景、1,200 个问题，历史最长 150k tokens；公开代码与 CC BY 4.0 数据可用，但论文仍是 2026 年预印本。
- 它不是问“新事实有没有被取回”，而是分别测试：能否判断旧状态已经失效、能否拒绝问题中偷偷夹带的过时前提、能否把更新后的状态用于后续行动。
- 这比显式 `old/current` 标签更接近真实长对话：后来的事件可能没有说“我推翻之前的话”，却已使旧偏好、旧假设或旧计划不再成立。
- 用作 `supersedes` 推断和 current-basis 重建诊断，不作为已正式发表的排行榜证据。

### 来源权限边界：AuthMem-Bench

- 2026 年预印本的受控配对 benchmark：保持命题与后续任务相同，只改变命题来自用户、助手还是工具，测记忆压缩是否把来源权限洗掉。
- 它直接支持生产审计提出的要求：压缩后的 claim 不能因为丢失 role/provenance 就从“助手建议”升级成“用户已经确认的方向”。
- 但这里的 authority 是“能否授权动作”，不等同于科学证据的 epistemic credibility。它只作为来源/控制权单元测试，不能替代 MemSyco、RECON 或科学任务成功率。

### 科研判断北极星：PaperArena / SciConBench / LifeSciBench

- **PaperArena**：公开代码与数据，跨多篇论文、工具调用和多模态证据完成真实研究问题；最终答案准确率与工具效率适合做后续端到端科研压力测试。
- **SciConBench**：9,107 个来自系统综述的科学问题与专家结论，测证据质量、冲突整合、事实 precision/recall/F1；其 clean-room 设计说明必须阻断答案材料泄漏。当前论文为预印本，尚未找到可验证的公开数据/代码入口，先作为协议参考。
- **LifeSciBench**：750 个专家编写、专家复核的生命科学任务，按任务级 pass rate 和细粒度 rubric 衡量证据处理、实验设计与决策实用性。它最接近最终产品价值，但当前未提供公开下载，因此不能冒充可运行 benchmark。

这三者不用于调索引的早期内环。只有 MemSyco/STALE/RECON 证明“证据选择与更新判断”改善，再用 PaperArena 验证是否真的提升科研任务结果；不可获取的数据只作为产品目标，不产生分数。

## “有效证据”的生产定义

对当前决策变量 $d$，候选证据 $e$ 的价值不是文本相似度，而是它在当前时间与权限边界内能否改变可执行判断：

1. **决策作用**：支持、反驳、更新、限定适用范围、补足完成条件，或证明当前证据不足；
2. **来源/权限**：它能证明事实、只代表助手建议、还是已经得到用户确认；操作权限与认识论可信度分别记录，不能混成一个 authority 分数；
3. **时间有效性**：它是 current、historical、superseded 还是 validity unknown；
4. **独立性与增量信息**：是否只是重复已有证据，还是增加独立来源、反面证据或新的依赖边；
5. **行动影响**：加入它后是否会改变选择、置信度、停止/继续实验、拒答或请求用户共同决定。

上下文选择因此是有预算的 evidence-set optimization，而不是独立段落 top-k：优先补齐当前判断所缺的证据槽；重复同一结论的第 N 段应递减，无法影响任何决策槽的相似背景应降级。benchmark 仍以最终成功率裁决，以上五项只用于解释为什么成功或失败。

### 回归：LongMemEval

保留现有分层 60 题，用于时间 provenance、知识更新、个人偏好和不可回答判断。它不再单独决定生产方案。

### 鲁棒性：CUB

ACL 2026 主会 CUB 提供 gold、conflicting、irrelevant 三类上下文。它用于验证组装器是否既能采用有效外部证据，又不被无关或冲突上下文劫持。

### 诊断而非总分：BRIGHT / NoLiMa

- BRIGHT（ICLR 2025 Spotlight）：1,398 个 reasoning-intensive retrieval 问题，判断检索器是否只靠表面相似度；其 nDCG 只解释候选生成，不能覆盖最终判断正确性。
- NoLiMa：低词面重叠的 latent association，只作为跨措辞召回诊断；仍属于 needle 结构，不代表真实产品成功率。

## 第一轮条件

在同一固定 Luna answer/judge 配置下做配对比较：

1. `local-current`：当前本地 raw-passage selector；
2. `luna-cue-fusion`：grounded claim + Luna future retrieval cue + local raw fusion；
3. `intent-hex`：`thematic scope / event type / entity role / time / authority` 的结构标签先筛选，compact hex posting 再产生候选；
4. `oracle-minimum`：仅给官方 answer turns，作为上下文选择上限，不参与生产选择。

先在 CAME Small 按两域、四题型分层抽样；只有新条件在最终 Macro-F1 上出现正向信号，才进入 Medium/Large。通过后再进入 MemoryArena 的小规模端到端任务；只有 Task Success Rate 不下降才允许进入生产。避免先为全量数据支付 Luna token。

## 防泄漏

- `answer_turn_ids`、gold answer、官方 partition/action 标注不得进入 assembler、tagger 或 answer model；
- 只能在打分阶段读取 answer IDs/answers；
- query-side scope 必须由生产可用状态或当前文本推导，不能读取 benchmark 的 gold partition；
- Oracle 单独标记，不进入候选方案排名；
- cache key 包含数据哈希、tag prompt、schema、condition、model 与 reasoning。

## 成功率优先的改进假设

### H1：目标范围先于相似度

历史 claim 增加三个 retrieval-only 字段：

- `thematicScope`：它服务的目标/阶段；
- `eventType`：决定、修订、比较、观测、反驳、总结等；
- `entityRoles`：实体在该目标中的角色，而不只是实体字符串。

在线查询不调用 Luna。当前 Idea 的 route/stage 元数据提供稳定 scope anchor；prompt/P1 只做本地特征编码。先按结构兼容性形成 tier，再在 tier 内用 hex-IDF 排序。结构不匹配是降权，不是永久删除，避免标签错误造成单点失效。

### H2：增量修订必须带状态关系

`supersedes / contradicts / supports / about_version` 用于命中后的一步有界扩展。对同一 entity-role 的多个值，必须同时带时间与 status，不能只取最高词法分数。

### H3：优化证据集合，而不是独立 top-k

候选选择需要覆盖不同证据槽：当前目标、关键实体角色、更新链、必要多跳邻接和反面证据。只有新增候选补足未覆盖槽位时才消耗 token。LongMemEval 可研究 `2.5k -> 5k -> 7.5k` 梯度；CAME-Bench 始终服从官方 4,096-token hard cap，不因相似段落重复堆积。

### H4：标签层只做 candidate generation

标签不能生成事实、不能成为权威，也不能独自宣告证据充分。最终注入始终回读逐字 quote、独立时间和 provenance。低结构置信度时融合本地 raw 候选，而不是等待 Luna。

## 采用门槛

按词典序决定：

1. 最大化最终 Macro-F1/任务成功率；明显下降的省 token 方案淘汰；
2. 正确率统计等价时，最小化注入 tokens；
3. 前两项相当时，最小化本地 assembly median/P95；
4. 本地回退成功率不得低于 Luna 增强方案超过 10 个百分点；
5. 每 block 本地建索引 <1 s、每 loop 查询与组装 <2 s；实际目标远低于硬上限。

检索 recall、evidence recall 和标签准确率都只作解释变量。即使这些指标上升，只要 MemoryArena Task Success Rate 或 CAME answer score 明显下降，方案仍淘汰。

论文配置使用 gpt-5-mini 生成、gpt-4.1-mini 评判；本项目 pilot 固定使用 Luna 生成/评判以符合订阅和成本约束。因此 pilot 只用于方案内配对比较，不宣称与论文 leaderboard 数字直接可比。

## 当前数据状态

- **CAME-Bench**：官方编码发布已下载；用作者 `codec.py` 严格解码，29/29 文件通过大小和 SHA256 校验。No-leak adapter 载入 14 条轨迹、373 题，内部内容摘要为 `sha256:a965affaf69664332d40d0d1f93c0149e8485e26303f48a05a5d3517c1d81036`。
- **MemoryArena**：五个官方 JSONL 已下载并逐文件校验，共 701 题；不得把离线数据读取误报为完整环境 Task Success。
- **MemSyco-Bench**：五个官方 JSONL 已下载，共 1,550 题；发布清单按 canonical CRLF 字节计算，规范化后 5/5 SHA256 匹配，loader 同时记录 raw 与 canonical 匹配模式。
- **STALE**：公开数据已确认，共 400 行；单个发布文件约 306 MB。先完成 MemSyco 配对 pilot，再决定下载全量或固定哈希的分层子集，避免为功能堆积数据。
- **GaRAGe**：官方 28,426,483-byte JSONL 已下载并校验，SHA256 `419e3941f6e8eb4082a74ca2140c1f9337f8b467ff76656a6b8b0290ca3f3a72`；正在接 no-leak adapter。
- **RECON / PaperArena**：公开入口已确认，尚未接入。

本机直连 GitHub/Hugging Face 的 TLS 仍异常；下载通过用户已有的 `ktbv` SSH 主机作传输中继，未关闭 TLS 校验，也未把远端当作信任根。所有落地数据仍必须由发布方清单或内容哈希验收。

## 已完成的方向淘汰实验

2026-08-13 的 LongMemEval-S 分层 12 题 Luna pilot：

- `local-current`：11/12，平均注入 6,365.8 tokens，assembly P95 127.6 ms；
- `luna-cue-fusion`：11/12，平均注入 8,023.6 tokens，assembly P95 112.7 ms；
- 两者唯一共同失败为 single-session preference 题；Luna cue 没有改变任何题的正确与错误。

结论：cue-only 增强在这轮没有任务成功率信号，却多注入约 1,658 tokens（约 26%）。不进入 60 题全量，不并入生产。下一轮必须验证 contextual intent、证据权威或更新链，而不是继续添加泛化检索提示词。结果文件：`research/benchmarks/longmemeval/results/longmemeval-2026-08-13T02-53-27-133Z.json`。

## 来源

- CAME-Bench / STITCH: https://aclanthology.org/2026.findings-acl.584.pdf
- Dataset: https://huggingface.co/datasets/Seattleyrz/CAME-Bench
- Code: https://github.com/Seattleyrz/contextual-intent
- MemoryArena (ICML 2026): https://openreview.net/attachment?id=JHYmxqS9Jv&name=pdf ; https://arxiv.org/abs/2602.16313
- MemoryArena project/data: https://memoryarena.github.io/ ; https://huggingface.co/datasets/ZexueHe/memoryarena
- MemSyco-Bench: https://arxiv.org/abs/2607.01071 ; https://github.com/XMUDeepLIT/MemSyco-Bench
- RECON: https://arxiv.org/abs/2607.16716
- CUB: https://aclanthology.org/2026.acl-long.1151/
- BRIGHT: https://openreview.net/forum?id=ykuc5q381b
- NoLiMa: https://proceedings.mlr.press/v267/modarressi25a.html
- STALE: https://arxiv.org/abs/2605.06527 ; https://github.com/icedreamc/STALE ; https://huggingface.co/datasets/STALEproj/STALE
- AuthMem-Bench: https://arxiv.org/abs/2608.01679
- PaperArena: https://arxiv.org/abs/2510.10909 ; https://github.com/ustc-ai4science/PaperArena
- SciConBench: https://arxiv.org/abs/2606.11337
- LifeSciBench: https://openai.com/index/introducing-life-sci-bench/
- τ-Knowledge: https://openreview.net/forum?id=XHZK5abtw2 ; https://github.com/sierra-research/tau2-bench
- GaRAGe: https://aclanthology.org/2025.findings-acl.875/ ; https://github.com/amazon-science/GaRAGe
