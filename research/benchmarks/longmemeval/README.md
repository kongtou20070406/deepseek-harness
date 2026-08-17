# LongMemEval-S 双轨上下文评测

## 决策目标

方案选择采用严格字典序，不使用加权总分：

1. 首先比较公开任务成功率；明显掉正确率的省 token 方案直接淘汰。
2. 只有配对正确率在 95% 区间内满足预登记的 ±2 个百分点等价界值，才比较平均注入上下文。
3. 前两项相当后，才比较本地组装中位数与 P95。

纯本地轨道相对 Luna 增强轨道使用 10 个百分点非劣界值。最低推断样本为 60；少于 60 题只算管线烟测，不产生赢家。

## 两条生产同构路径

- `luna`：预先对所有稳定 raw fold units 运行生产 `evidenceTagPrompt()`，逐字 quote/hash 校验全部通过后，由 `compileDualTrackContext()` 使用 grounded claims。
- `local`：向相同函数传入空增强索引，立即从原始消息建立确定性 passage 索引；没有任何在线模型或等待。

两条路径使用同一个回答模型和同一个独立裁判，只改变被注入的历史上下文。回答顺序按题交替，降低时间顺序偏差。2026-08-13 的锁定 60 题运行是在用户限时授权下使用 Sol/max 作回答与裁判，Luna/low 只生成标签；授权结束后已停止全部 Sol 进程，后续实验以 Luna 为主。因此该结果不能与不同回答模型的公开分数直接比较。

## 标签泄漏防护

`adapter.mjs` 在组装前物理拆分数据：

- 选择器只看到 question、question date、盲化 session id、date 和 raw role/content。
- `answer`、`answer_session_ids`、`has_answer`、原始 `question_id` 与证据 session id 只留在私有评测表。
- 所有选择器输入递归冻结，并逐题执行 forbidden-key 与原始证据 ID 检查。
- 答案文字可以合法出现在原始证据中；被隐藏的是它作为答案的标签与位置，而不是证据本身。

## 使用

先验证数据与泄漏隔离，不调用模型：

```powershell
node research/benchmarks/longmemeval/run.mjs --data=research/benchmarks/third_party/longmemeval/longmemeval_s_cleaned.json --sample=60 --validate-only
```

运行 60 题分层 pilot：

```powershell
node research/benchmarks/longmemeval/run.mjs --data=research/benchmarks/third_party/longmemeval/longmemeval_s_cleaned.json --sample=60
```

当前 runner 默认使用 Luna/high 作回答与裁判，Luna/low 作后台标签；可通过 `--answer-model`、`--answer-reasoning`、`--judge-model`、`--judge-reasoning` 显式覆盖。所有 Luna 标签、回答与裁判调用都进入同一个 1 亿 token 总账。历史 Sol 锁定结果仍保留，但不会被默认复用为新配置成绩。

协议测试：

```powershell
node --test research/benchmarks/longmemeval/test.mjs
```

## 当前证据状态

- 官方 `longmemeval_s_cleaned.json` 已下载并验证：500 题、277,383,464 bytes，SHA-256 `35961662da991bec512124586e2e399a335e9e7c94272403e820eccc9946589e`。全量 500 题标签泄漏审计通过。
- 官方 `longmemeval_oracle.json` 同样已验证：SHA-256 `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`。Oracle 中位数只有 2 个 session，代码默认拒绝用它做检索对比。
- 锁定的分层 60 题结果位于 `results/longmemeval-2026-08-13T01-54-29-708Z.json`：local 44/60（73.33%），Luna 46/60（76.67%）。local − Luna = −3.33 个百分点，配对 95% CI 为 [−10.0, +3.33]；local-only 1，Luna-only 3。
- local 平均注入 7,056 tokens，组装中位数/P95 为 104.1/129.9 ms；Luna 平均注入 8,693 tokens，组装中位数/P95 为 107.3/118.4 ms。
- 样本达到最低推断门槛，但区间仍跨过等价与预登记非劣边界，结论是 `accuracy-inconclusive`，没有赢家。Luna 的 +3.33pp 只是方向性证据。
- 两条路径在 preference 都是 0/6；这是下一轮优先修复的真实 failure slice。
- 已开始的 claims-only 消融只完成 35/60 即因模型授权变化停止，不做统计推断。早期错误已足以否决“只注入 claims、完全去掉 raw evidence”作为默认生产方案。
- Luna 总账为 13,378,555 / 100,000,000 tokens。64 个 benchmark worker 曾占约 8.4 GB 内存，已否决；32 只用于离线测量，生产仍保持有界小队列。

数据与官方评测定义来源：[LongMemEval 官方仓库](https://github.com/xiaowu0162/LongMemEval)。当前裁判复用官方 prompt 语义，但不冒充官方 gpt-4o 排行榜成绩。外部结果与下一版设计见 `research/CONTEXT_ASSEMBLY_LEADERBOARD_SCAN_2026-08-13.md`。
