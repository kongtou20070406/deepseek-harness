# LSC-EPC CPU 验证记录

日期：2026-08-13
范围：零模型调用、零 GPU、串行执行
环境：Windows / Node.js v24.16.0 / npm 11.13.0 / Pi 0.84.1

## 结论

LSC-EPC 的确定性实现、Pi 接线、跨 session raw memory、事件时状态坐标、current/historical recall、依赖闭包、覆盖停止和 60%/85% 水位均通过本地测试。6-case 意图回放中完整结构 6/6 且无目标漂移；固定 5% MemSyco 中，当前 loop-island v3 生产组装比 raw 少约 23.00%。由于本轮没有模型回答或裁判，**不能据此声称任务表现不变**。

## 1. 扩展与 Pi 集成

在 `pi-idea-extension` 下执行：

```powershell
node --test --test-concurrency=1 test/*.test.js
npm run test:pi
npm run test:installed
```

结果：

- extension unit tests：70/70 pass；
- Pi RPC smoke：pass，扩展加载、命令注册和 `/idea-propose` 均未调用模型；
- installed Pi smoke：pass，项目本地 package 加载成功。

其中包括旧 SQLite index 坐标迁移测试：先清除已存 block 的 Idea/stage metadata，随后 replay 同一 immutable session；结果只回填坐标，block count 与 FTS row count 均保持 3，没有重复索引。

## 2. Compiler 与官方 MemSyco 合同

```powershell
node --test --test-concurrency=1 research/benchmarks/bidirectional-context/compiler.test.mjs research/benchmarks/bidirectional-context/local-ablation-protocol.test.mjs research/benchmarks/bidirectional-context/memsyco-ablation.test.mjs research/benchmarks/memsyco/adapter.test.mjs research/benchmarks/memsyco/protocol.test.mjs research/benchmarks/memsyco/runner-core.test.mjs
```

结果：原有 compiler + official MemSyco 合同 45/45 pass；加入 Sol paired protocol 与通用 model budget 后，task-relevant 总计 52/52 pass。官方 MemSyco release 的 1,550 rows、固定 digest、online/gold 隔离、deterministic sampling、verbatim evidence、condition blinding、冻结后判分、授权拒绝和预算硬门均通过。

额外运行全部 benchmark tests 得到 85/90 pass。5 个失败全部为第三方数据未安装导致的 `ENOENT`：CAME 1、GaRAGe 2、MemoryArena 2；不是断言或 LSC-EPC 回归。本轮范围已冻结为 5% MemSyco，因此没有下载这些额外数据集。

## 3. Context-reinstatement synthetic diagnostic

命令：

```powershell
node research/benchmarks/context-reinstatement/run-cpu.mjs
```

输出：`research/benchmarks/context-reinstatement/results/context-reinstatement-cpu-20260813.json`
当前 artifact SHA-256：`73C3AF630A8919428B8B316C5F48A3BB77AA29E50F3B9186CCA235B243A5F85E`
case generator digest：`sha256:2b0c80788442ce28428f019cad2d1008a71e8885ef08e276ddfb352a74e8732a`

| selector | current cases | current accuracy | distractor@1 | historical cases | historical accuracy | current mean tokens | current p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| lexical-only | 60 | 0.50 | 0.50 | 20 | 1.00 | 62.68 | 0.133 |
| contextual reinstatement | 60 | 1.00 | 0.00 | 20 | 1.00 | 62.85 | 0.263 |

这个诊断特意构造同词、不同 Idea/stage 的候选；一半 stale evidence 放在更晚位置，使 recency 不能代替状态坐标。它只证明 context-validity tie breaking 与 historical guard 的程序行为，不是现实任务正确率。

## 4. 固定 5% MemSyco assembly-only pilot

命令：

```powershell
node research/benchmarks/bidirectional-context/run-memsyco-ablation.mjs --sample-percent=5 --budgets=8192 --output=research/benchmarks/bidirectional-context/results/memsyco-lsc-epc-5pct-cpu-20260813.json
```

输出 artifact SHA-256：`E8D779A6E9D59E6E93565A1276C01CAC94CECDACA5523E4DC12D50F0C618BD47`
官方 dataset SHA-256：`2f4153d11a2cf4bd05b919d6e01adabdbe3cb695729adfbab2938f02dd37cecb`
sample seed：`memsyco-five-local-5pct-v1`
sample：78 / 1,550，按 task 分层 5%

| condition | complete | mean tokens | p50 | p95 | max | assembly p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| raw | 78/78 | 2054.59 | 2068.5 | 3492.6 | 3703 | 0.524 |
| positive-only | 78/78 | 1582.03 | 1586 | 2340.85 | 2904 | 0.463 |
| gc-only | 78/78 | 2054.59 | 2068.5 | 3492.6 | 3703 | 0.436 |
| bidirectional | 78/78 | 1582.03 | 1586 | 2340.85 | 2904 | 0.571 |
| bidirectional-heat | 78/78 | 1582.03 | 1586 | 2340.85 | 2904 | 0.438 |

生产 `bidirectional-heat` 相对 raw 的 mean token reduction：

\[
1 - \frac{1582.0256}{2054.5897} = 23.0004\%
\]

所有 `taskSuccess` 与 `falseDropRate` 都为 `null`。MemSyco 未发布 supporting turn ids，本轮也没有回答模型，所以 assembly-only 结果不能填造 oracle coverage 或任务成功率。

## 5. 多轮意图漂移回放

命令：

```powershell
npm run bench:intent
```

6 个由真实 Obelisk 交互结构匿名化得到的 replay 中，Pi-Idea 目标架构原型 6/6 pass、0 goal drift、mean 195 tokens；Codex-style rolling simulation 4/6 pass、1/6 goal drift、mean 818.83 tokens；retrieval-only 消融 2/6 pass。artifact SHA-256 为 `2AD12B4BB45D4E1815AB4CC2607F8C5CD7738EBB4CC0A9B42E633958E9C9486F`，连续两次生成一致。

该结果证明窄状态与 continuation/evidence pointer 是必要组件。生产扩展现已加入用户确认状态版本、worker 持久 frame、Idea/stage 失配拒绝、跨 session 完整岛恢复以及 tool-call payload 排除回归；它仍不证明 Sol 下游回答已经非劣。

生产压力脚本同时测量 21 个 rooted blocks 的 continuation frame 精确恢复：2,000 次中 P50 0.581 ms、P95 0.733 ms、P99 2.662 ms、最大 3.146 ms；因此“继续”路径没有牺牲 10 ms stretch gate。continuation frame 引用块也进入 cleanup protection closure，显式清理计划不能删除当前续接所需证据。

## 6. 固定 5% Sol/max 产品门最终结果

用户已明确授权固定 78-case 门。runner 先封存 78/78 在线回答，再开放 gold；盲判在 70/78 完整 case 后因一个不可解析 judge 输出按合同停止，未自动重试。70 个完整配对超过最低 60 个可评分 case；未评分 8 个是固定顺序尾部，因此保留截尾限制。

| 指标 | raw | LSC-EPC | paired difference | 95% paired bootstrap | 5pp 非劣 |
|---|---:|---:|---:|---:|---:|
| task success | 94.29% | 87.14% | -7.14pp | [-14.29pp, -1.43pp] | 失败 |
| correct authority use | 100.00% | 91.43% | -8.57pp | [-15.71pp, -2.86pp] | 失败 |
| mean evidence tokens | 2104.73 | 1613.30 | -23.35% | 不适用 | 性能门失败，不采纳 |

raw-only task regressions 共 5 个，其中 `valid_memory_selection` 3 个为 retrieval missing；另有 contextual scope/authority 退化。结论不是“压缩还不够”，而是当前选择器删掉了完成任务必需的信息。按任务表现优先合同，选择性 LSC-EPC 被拒绝，交付版默认保留 Pi 原生上下文。

Sol-only runner、manifest 与预算门已经完成零调用验证：

- manifest hash：`sha256:e0157bdf32bc2af6f2002ad10bae7565dcaa1cb5d90bd3caf4de88050c81911c`；
- normal calls upper：286；hard call stop：416；
- estimated answer input：281,314 tokens；
- answer input by condition（含相同 system/request framing）：raw 182,887，production LSC-EPC 146,028，减少 20.15%；
- conservative judge input upper：680,838 tokens；
- total input estimate upper：962,152 tokens；
- observed token hard stop：8,000,000；
- durable preflight：`research/benchmarks/bidirectional-context/results/sol-lsc-epc-5pct-preflight-20260813.json`，SHA-256 `5331EF6F926B5433F7DF5B55D69BB66EC3D0EBF019F4CFE2B7C97B3C603EDA8B`；
- 无授权标志时 runner 已实测 fail closed；
- validate-only 与 dry-run 都报告 `modelCalls=0`；
- 当前 Pi `openai-codex` 只读认证探针为 `ready/oauth`；旧探针与 Pi 0.84.1 JSON 状态合同不兼容的问题已修复并加入测试。

最终 ledger observed total 为 1,045,134 tokens（含两次保守失败记账），远低于 8M 硬停止；全程严格串行、CPU 本地编排、未占用 GPU。用户已要求本次后不再进行模型测试。
