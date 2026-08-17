# Pi Idea 上下文组装

> **历史设计，已被替代。** 本文记录早期 fold/Luna-tag 路线，不再是生产合同。2026-08-14 起，旧文中的 P0 只对应 Idea Kernel；当前路线已移入用户确认的 Research Frame，短期推进状态移入模型可填充但不可裁决的 Working State。生产方案以 `research/FINAL_CONTEXT_ASSEMBLY_SCHEME_2026-08-13.md` 和 `research/PI_IDEA_CLI_FIRST_DUAL_KERNEL_PLAN_2026-08-14.md` 为准；默认关键路径不调用模型、不生成摘要。

## 一、设计原则

1. **Idea 高于记忆。** 用户确认的 P0 是权威输入，不属于摘要系统；每次主模型调用都逐字放在第一条消息最前。
2. **原始历史高于索引。** Pi 当前会话分支的原始 message entries 是事实源。标签、索引、manifest 和缓存都可重建。
3. **保留全局责任。** 主模型携带完整 P0 并决定工作；Luna 只给已经完成的工作块生成可回指标签，不判断科研方向。
4. **在线路径必须轻。** 每轮只做确定性分块、词项相关性、预算选择和哈希校验；Luna 在后台单并发运行。
5. **按任务结构压缩。** user + assistant + tool result 保持在同一个 turn；稳定 turn 再组成约 4.8k–7.2k token 工作块。这个范围来自当前 Luna pilot：相较原先细碎块，后台调用约降至三分之一，同时保持 8/8 决策正确。
6. **不递归派生。** 每个标签只从不可变原始块生成；标签不会再次成为 Luna 的输入事实源。
7. **标签必须可核验。** 每条标签都带原始块 ID、raw hash、逐字 quote 与 quote hash；程序找不到逐字 quote 就丢弃该标签。
8. **标签绝不阻塞主 Agent。** Luna 增强索引只有在所有稳定块都已就绪时才被采用；否则当前 loop 立即使用纯本地、逐字可回指的原文 passage 索引。标签失败只影响增强能力，不停止科研工作。
9. **显式原文读取。** 只有用户明确说“逐字、精确、核验、原文”等时，程序才沿已命中标签读取对应 raw block。
10. **召回有硬上限。** 派生证据最多占模型窗口 4.5%，上限 12k tokens；P0+P1 另受 1/20 预算约束。
11. **存储和调用有界。** 标签缓存 4 MiB/600 条；单队列、单并发、最多 8 个 pending；每块最多尝试 3 次，无递归 Agent loop。
12. **延迟看首 token 与分位数。** 正式 Pi 复用常驻进程；后台模型任务不得逐项重启 Pi。观测 TTFT、中位数和 P95，并把远端拥塞长尾与本地组装耗时分开。
13. **索引有硬 SLA。** 新块不等 Luna 即可本地检索，单块创建 P95 必须小于 1 秒；每次 loop 的查询、融合与上下文组装 P95 必须小于 2 秒。工程目标均为 250 ms 内，并单列冷启动、增量写入与热查询。

## 二、当前真实工程实现

### 权威层

- Idea 状态保存在 Pi 会话的 `pi-idea-state-v1` 追加事件中。
- P0 修改只有 `/idea-propose` → `/idea-confirm` 一条路径。
- 每版记录内容哈希、父版本哈希、版本和确认时间。
- `/idea-stage` 保存 P1；P0 与 P1 超预算时停止调用，不截断。

### 原始层

- 编译器每轮读取 `sessionManager.getBranch()` 中当前分支的原始 `message` entries。
- Pi 的 compaction entry 不会取代这些原始消息；因此退出、恢复、分支或手动 `/compact` 后仍能重新分块。
- 不复制第二份完整历史，避免长期存储翻倍。

### 派生层

- `groupTurns()` 形成不可拆分 turn；`makeFoldUnits()` 默认按 4.8k–7.2k tokens 形成稳定块。
- 块 ID 由原始 turn IDs 哈希得到。低于稳定阈值的尾块继续留在活跃上下文，不索引临时 ID。
- Luna 直接通过 model registry 完成一个无工具、无 Agent loop 的低思考调用；只收到块原文以及 Idea/阶段 hash，不收到可修改的 P0。
- Luna 输出最多 12 条结构化 claim；程序验证 `kind/authority/status` 枚举，并把 quote 重新定位为原始块中的逐字切片。session id 与 date 是每条 claim/passage 的独立 provenance 字段，不依赖日期文字恰好和事实落在同一分句。
- 标签包含 claim/source/raw/quote 哈希、实体和可选 typed links。错误、缓存与重试状态保存在 `~/.pi/agent/idea-extension/<session-hash>/evidence-index.jsonl`；旧 `summaries.jsonl` 不再进入生产索引。

### 在线选择

- 查询由逐字 P0 + 当前用户 prompt + P1 组成。P0 在这里只是只读 query enrichment：它不进入候选块、不参与压缩，也不会被编译器改写。
- 中文使用双字词项，英文/标识符使用词项；相关性按文档频率加权。当前是内存中的确定性稀有词检索，不是向量检索，也未声称已经使用 SQLite FTS5/BM25。
- 例行“没有新结论”标签在排序前由程序删除；增强轨道最多选择 12 条 grounded claims，并用剩余预算补入本地逐字 passages。它是结构化索引与原文证据的融合，不是 claims-only 摘要。
- 纯本地轨道索引所有非例行原文 clause，以 P0、P1 和当前任务做确定性稀有词评分，再沿同消息相邻 clause 与共享标识符做有界扩展；不依赖向量服务或模型标签。
- 增强索引只在全部稳定块存在 grounded claims（允许空 claims）时启用；否则立即走本地轨道，并把缺失块交给有界后台队列。在线等待时间固定为 0。
- 最近 4 个完整 turn 与未稳定尾块保留在活跃上下文。
- 最终消息顺序固定为：`逐字 P0 anchor` → `结构化派生证据` → `最近活跃 turn`。

### 与 Pi 原生压缩的关系

Pi 0.84.1 在模型返回后依据“实际请求上下文”的 usage 判断阈值；context extension 在请求前已经替换为受控活跃上下文。因此正常情况下不会等完整会话树涨到窗口上限才开始压缩，也不需要等待 Pi 全局摘要。

Pi 原生 compaction 仍保留为溢出安全阀和用户手动功能。Idea 的 P0 和原始分支读取不依赖 compaction summary。

## 三、每条用户消息 / 每次 Agent loop 的时序

### 用户消息进入时

1. 若当前对话未启用 Idea，扩展不注入上下文，Pi 保持普通对话。
2. 若启用，确定性检查 P0/P1 预算；不通过则在模型调用前停止。
3. 保存当前 prompt，供任务分类和检索使用。

### 每次模型调用前（包括同一任务中的工具回合）

1. 从当前 Pi 分支读取原始 messages。
2. 以 user turn 为边界分组，保证工具结果不脱离所属工作。
3. 保留最近 4 turn；较旧 turn 组成稳定 fold units。
4. 查哈希缓存：若所有稳定块都有结构化标签，选择 Luna 增强轨道；否则立即选择纯本地原文轨道，并把缺失块加入最多 8 个 pending 的 Luna 队列。
5. 用只读 P0 + prompt + P1 做确定性相关性评分；P0 本体仍只存在于第 0 条逐字 anchor。
6. 增强轨道在固定预算内选择 grounded claims；本地轨道在相同预算内选择带 source/raw/quote hash 的逐字 passages。二者均不等待在线模型调用。
7. 记录本轮 `contextTrack`、增强索引是否完整、后台调度数和 `indexWaitMs=0`；Luna 后续成功只影响下一次 loop。
8. 构造第 0 条逐字 P0 anchor；附加最小自治边界、实现任务的最小工程约束，以及最多一个按需工具箱原子。
9. 生成 manifest：P0/阶段哈希、预算、选择/省略块、压缩比和来源。
10. 把组装后的上下文交给 Pi；主模型只看到当前需要的证据和最近工作。

### 模型工作期间与结束后

1. 工作区内普通操作自主进行；外部写入或高置信不可恢复操作才询问。
2. 工具结果仍进入模型上下文，但主 TUI 不显示其过程；有界 trace 可按需检查。
3. 每轮 settle 后，Luna 队列立即在后台串行标注新稳定块；通常在下一条用户消息前已经完成。
4. 若下一次 loop 仍未完成，继续使用本地轨道；每块后台最多尝试三次并按退避时间重试，绝不形成递归 Agent loop。
5. 模型产生的 Idea 或 Skill 只能成为候选，不能自动获得权威。

## 已实现与尚未声称实现

已实现：逐字 P0、版本事件、自由格式候选、每 loop 编译、turn/block folding、后台 Luna 结构化标签、逐字 quote/hash 验证、非阻塞双轨选择、本地原文 passage 回退、manifest、有界日志、三次后台失败退避、会话队列隔离、直接 IDEA 写入阻止、工具过程隐藏和 Skill 人工提升。

尚未声称：数周真实科研任务上的质量提升、双轨方案在 LongMemEval-S 上达到统计非劣、向量/图检索优于当前词项检索、自动科学方向判断或通用多 Agent 调度。完整 S 数据与 500 题泄漏审计已完成；60 题配对结果中 Luna 为 46/60、本地为 44/60，但置信区间不足以宣布赢家或统计等价。

## 四、生产选择器的验证依据

新增 8 case × 3 repeats 的选择器 benchmark 表明，“程序索引 + Luna 后台结构化标签”是当前最好的可部署条件：24/24 正确，pass³ 100%，平均上下文约 2,131 tokens，在线选择中位 0.22 ms，端到端中位 2.245 秒。在线 Luna 选择虽达到 100% 证据召回，但中位延迟 6.456 秒，因此不进入每 loop。

并入生产解析器后又复验 24 次：逐字 quote 校验和严格无 raw 回退下仍为 24/24 正确、pass³ 100%、回答证据召回 100%；在线选择中位 0.94 ms，端到端中位 2.338 秒、P95 3.123 秒。平均上下文约 4,109 tokens，因为生产路径保留最近 4 个完整 turn，而原先 2,131-token 条件只保留 2 个 recent turns。

当前生产路径已改为非阻塞双轨。事实源仍是 raw event；Luna 每个稳定块生成一次带 provenance 的 `kind/authority/status/entities/links` 标签，在线程序只做枚举校验、例行噪声过滤、确定性词项选择与预算裁剪。若增强索引未完整，本地选择器直接从 raw messages 建立有界 passage 索引，组装后继续 Agent；不会等待或停止。完整公共评测协议与当前证据边界见 `research/benchmarks/longmemeval/README.md`。

正式 LongMemEval-S 分层 60 题中，本地为 73.33%，Luna 增强为 76.67%；Luna 多用约 1.64k tokens，组装延迟相近，但 +3.33pp 仍统计不确定。两者在 preference 均为 0/6，说明当前“字面事实 + 稀有词”索引没有解决 cue–trigger 语义断裂。

下一版只针对这个真实缺口增加三项：后台 Luna retrieval cues、SQLite FTS5/BM25F 分字段索引、temporal/update/preference 覆盖门与有界自适应预算。在线路径仍是纯本地确定性代码；不启动检索 Agent。论文与开源实现依据、对照数字和实验顺序见 `research/CONTEXT_ASSEMBLY_LEADERBOARD_SCAN_2026-08-13.md`。

小于 0.5B 的本地模型只作为 FTS top 30–50 的可选 reranker，不负责 P0、事实抽取或最终上下文生成。优先试成熟 INT8 cross-encoder；超时或缺失立即沿用确定性第一阶段排序。选型、许可证、Parameter Golf 可借机制和训练门槛见 `research/LOCAL_RERANKER_AND_PARAMETER_GOLF_2026-08-13.md`。

标签的在线表示不要求人类可读。下一版可把 raw/cue/entity/time/authority/relation 分别编码为带通道前缀的 64-bit hex labels 和 posting lists；Luna cue 明文可在哈希后不进入在线索引。标签只负责把 query 路由到 grounded raw passage，不能作为注入内容或权威事实。60 题原型的单块建码 P95 为 1.53 ms、查询 P95 为 0.43 ms，但 preference recall 尚未优于当前选择器，所以仍处于研究路径。

当前“索引查找”仍是过渡实现：标签按 block hash 从 JSONL 尾部恢复到内存 Map；每轮把全部 claims 与重新切出的 raw passages 扫一遍，计算词项稀有度、精确标识符和权威/冲突加分，再沿相邻 clause/共享标识符扩展。它在 60 题长历史上完整组装 P95 约 118–130 ms，已经通过 2 秒硬门，但计算量随历史线性增长、字段无法分别调权且难以召回隐含偏好。下一版的 FTS5/BM25F 是为改善扩展性和任务成功率，不允许以延迟退化作为代价。
