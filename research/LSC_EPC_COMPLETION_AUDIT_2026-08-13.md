# LSC-EPC Goal Completion Audit

日期：2026-08-13
结论：`DELIVERED AS SAFE INFRASTRUCTURE; SELECTIVE COMPILER REJECTED`

| 原始要求 | 当前权威证据 | 判定 |
|---|---|---|
| 模型外长期记忆 | Pi raw session + workspace-scoped SQLite/FTS；跨 session capsule 与 raw replay test | 已实现并通过程序验证 |
| 研究意图连续 | 用户确认 Idea/version/hash + stage 构成窄 trusted state；anchor 字节前缀、版本 parent hash、跨 session restore tests | 已实现并通过程序验证 |
| 证据可追溯 | block 保存 session/entry/parent/time/raw hash/recoverable ref/Idea/stage；渲染带短 provenance；Manifest 保存完整选择理由 | 已实现并通过程序验证 |
| 去除大部分长对话冗余 | fixed 5% MemSyco loop-island v3：raw 2054.59 -> LSC 1582.03 mean context tokens，减少 23.00%；真实意图回放相对 rolling 少 76.19% | 已验证于两个冻结诊断；不外推为所有科研历史 |
| 交给 Sol 的内容以当前任务所需为主 | active-stage/Idea/global retrieval、current/historical guard、dependency closure、marginal coverage stop；context-reinstatement 80-case diagnostic | 已验证选择器行为；真实科研语义覆盖仍有外部效度限制 |
| 多轮目标不漂移 | 6-case 回放：目标架构原型 6/6、0 drift；rolling 4/6、1 drift；生产窄状态 version/parent、worker frame、跨 session 完整岛恢复均有回归 | 生产结构已接线并通过确定性回归；不外推为真实总体成功率 |
| 任务表现优先 | 固定门取得 70 个完整配对：task success `94.29% -> 87.14%`，差 `-7.14pp`；authority `100% -> 91.43%`，差 `-8.57pp` | **两个 5pp 非劣门均失败；拒绝采用选择性编译器** |
| 上下文量其次 | 可评分子集中 mean evidence tokens `2104.73 -> 1613.30`，减少 23.35% | 性能门失败，token comparison 不具备产品采纳资格 |
| CPU 延迟再次 | normal hot-path P95 0.804 ms；21-root continuation P95 0.733 ms；worker schedule P95 0.005 ms；segmentation P95 1.872 ms | 已测量，不作为主要优越性主张 |
| CPU-only / 不抢 GPU | 所有实现、测试、manifest、dry-run 均 CPU；preflight `gpuRequired=false` | 已满足 |
| 尽量串行 | Node tests 使用 concurrency=1；Sol runner 为先回答后判分的 strictly serial two-phase，任一时刻最多一个 Pi completion | 已满足 |
| 少用模型总结 | 生产上下文路径零模型、零摘要；临时 view 不写回记忆；summary-of-summary 禁止 | 已满足 |
| 60% 软线 / 85% 死线 | production compiler 按 runtime W 计算，mandatory closure 可越软线，越硬线 fail closed | 已实现并通过测试 |
| 固定 5% benchmark | immutable 78-case loop-island v3 manifest hash `sha256:e0157bdf32bc2af6f2002ad10bae7565dcaa1cb5d90bd3caf4de88050c81911c` | 已冻结，不自动扩展；同样本、同顺序、同数据摘要 |

## 最终处置

用户授权后，runner 严格先封存 78/78 在线答案，再开放 gold。盲判完成 70/78 case 后，一个 judge 返回格式无效；合同规定 judge 不自动重试，用户又明确要求本次之后不再做模型测试，因此没有补跑。70 个完整配对超过预注册最低 60 个可评分 case，但缺失为固定随机顺序的尾部，报告保留 deterministic truncation 限制。

结果 artifact：`research/benchmarks/bidirectional-context/results/sol-lsc-epc-5pct-88050c81911c-result-partial.json`。observed ledger 共 1,045,134 tokens，其中包含两次保守失败记账；正式阶段唯一模型格式失败发生在 judge，回答全部封存。选择性候选明确失败，不得描述为“任务表现不变”。

交付版因此默认 `safe`：保留 Pi 原生历史，只加入用户确认的 Idea/stage/narrow state 锚点；raw ledger、项目索引、完整 loop island、continuation frame、provenance、Manifest 和清理保护继续可用。`PI_IDEA_CONTEXT_MODE=experimental` 才能显式启用被拒绝的选择性路径。用户要求不再执行模型测试；后续只允许实现、UI 与非模型本地验证。
