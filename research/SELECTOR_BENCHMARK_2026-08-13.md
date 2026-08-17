# Pi Idea 上下文选择器 Benchmark

日期：2026-08-13
模型：`openai-codex/gpt-5.6-luna`，low reasoning
目的：在不使用向量检索的前提下，比较哪种上下文选择方式同时具有最低延迟和最高正确率。

## 1. 条件与公平性

- 8 条约 58.6k-token、64-turn 的长轨迹；覆盖方向否决、精度边界、冲突、版本、权限、检查点、新颖性和最小实现。
- 每种在线策略重复 3 次，共 24 次回答；条件顺序轮换。
- 主回答全部通过同样的常驻 Pi RPC、同一个 Luna 和相同输出 schema。
- `pass³` 要求一个 case 连续三次全部正确。
- 后台标签器只看 P0 identity 与已经完成的 raw block，不看最终问题；因此不能针对答案挑证据。
- Luna 标签是派生索引，不是权威事实；每条保留 raw block provenance。

比较条件：

1. `full_raw`：完整历史。
2. `block_compiler`：当前 P0-enriched 块摘要检索。
3. `program_tag_index`：Luna 后台给稳定块添加结构化事实标签；在线由程序确定性选择。
4. `online_luna_selector`：每轮先让 Luna 从同一标签集合选择证据，再调用 Luna 回答。
5. `oracle_minimum`：预先知道必需证据的不可部署上界。

## 2. 主结果

| 方法 | 正确率 | pass³ | 回答证据召回 | 上下文 | 在线选择中位 | 端到端中位 | P95 | 总 usage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Full Raw | 100% | 100% | 93.75% | 59,259 | 0 | 2.869 s | 4.835 s | 939,302 |
| 当前 Block Compiler | 100% | 100% | 83.33% | 4,740 | 3.34 ms | 2.409 s | 3.243 s | 95,899 |
| 程序 + 后台标签 | 100% | 100% | 93.75% | 2,131 | 0.22 ms | **2.245 s** | **3.966 s** | 43,936 |
| 在线 Luna 选择 | 100% | 100% | 100% | 2,108 | 3.659 s | 6.456 s | 9.130 s | 101,869 |
| Oracle Minimum | 100% | 100% | 100% | 1,920 | 0 | 2.111 s | 2.749 s | 38,382 |

程序索引在删除“没有新结论/没有新证据”等标签噪声后另做 24 次复验：仍为 100% 正确、pass³ 100%，回答证据召回提高到 97.92%，上下文 2,141 tokens，选择中位 0.09 ms，端到端中位 2.428 秒。P95 4.333 秒来自两次远端 TTFT 长尾，而不是本地选择。

生产代码合入后，使用同一批已缓存标签对真实 `parseEvidenceTags()` + `compileContext(strictEvidenceIndex=true)` 再做 24 次复验：24/24 正确、pass³ 100%、回答证据召回 100%、证据精度 86.11%，上下文 4,109 tokens，选择中位 0.94 ms，端到端中位 2.338 秒、P95 3.123 秒。上下文增加来自生产路径保留 4 个 recent turns，而最小条件只保留 2 个。

两轮程序索引合计 48 次：

- 正确率 100%；
- 回答证据召回 95.83%，上下文选择本身覆盖全部必需证据；
- 平均上下文 2,136 tokens；
- 端到端中位 2.292 秒，P95 4.064 秒；
- 44/48（91.7%）低于 4 秒；
- 本地选择约 0.1–0.2 ms；
- 首 token 后的短 JSON 生成约 0.46 秒，超过 4 秒主要是远端排队。

## 3. 为什么不用纯向量检索

向量相似度回答“语义上像不像”，但当前任务首先需要回答：

- 这条信息是否由用户确认？
- 它属于哪个 Idea/路线/阶段版本？
- 它是否已经被另一条记录取代或否决？
- 它是支持、反对还是未解决冲突？
- 它是否只是工程建议或工具过程？

例如 `KAPPA=0.42` 与 `KAPPA=0.37` 的 embedding 必然高度相似，但相似度无法决定哪个是当前权威版本。因此默认索引采用：

```text
权威/版本/状态硬过滤
→ FTS/BM25 直接词项检索
→ supports / contradicts / supersedes / about_version 关系扩展
→ 按证据类型覆盖并去重
→ 未完成标签则等待；索引完成但无命中则不注入旧证据
```

向量只保留为将来的低权重补召回实验；它不得覆盖版本、权威和冲突规则。V0 不需要向量数据库。

## 4. 后台 Luna 的正确位置

标签阶段处理 80 个稳定 raw-rooted blocks：必需证据抽取召回 100%，约 331,889 tokens，平均 6.645 秒/块。这个成本不在用户请求路径，并且每块只执行一次。

生产实现中，结构化标签应**替代**当前自由文本块摘要，而不是叠加第二次调用。每条标签至少包含：

```text
claim_id, raw_block_id, raw_quote_hash,
kind, authority, status, entities,
idea_version, route_version, stage_version,
supports, contradicts, supersedes
```

程序验证 quote/hash 和枚举字段；错误标签可删除并从 raw 重建。Luna 不能修改 P0、确认版本或自动解决冲突。

## 5. 决策

默认方案选择 `program_tag_index`，原因是它位于可部署方法的 Pareto 前沿：与在线 Luna 选择具有相同的 100% 决策正确率，但中位延迟低约 4.2 秒、usage 低约 57%；相较当前块编译器，上下文减少约 55%、证据召回更高、选择更快。

在线 Luna selector 不进入每 loop。生产扩展已采用严格标签模式：后台提前生成，下一轮尚未完成则等待；三次失败停止该轮，绝不静默回退整块原文。typed relation expansion 暂未进入选择路径。

原始报告：

- 生产严格模式：`research/benchmarks/harness-performance/results/selector-benchmark-2026-08-12T23-37-17-041Z.json`
- `results/selector-benchmark-2026-08-12T23-00-13-290Z.json`
- `results/selector-benchmark-2026-08-12T23-17-58-726Z.json`

截至生产复验结束，Luna 累计总账为 3,391,567 / 100,000,000 tokens、677 calls，Sol 为 0。
