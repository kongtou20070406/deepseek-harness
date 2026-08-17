# Evidence Ladder 三批 Luna-low 配对门记录

状态：`SHORT GATES RETAINED AS FAILURE HISTORY / LONG-HORIZON V2 PASSED / SOL COMPLETED`
日期：2026-08-14

## 固定协议

- 数据：MemSyco 官方 1,550 case 本地镜像；
- 每批：32 个 online-safe 困难 case；
- 五个任务均覆盖；
- 每一批排除所有过去进入过任何 frozen-online 模型运行的 case；
- raw 与 candidate 回答顺序确定性随机；
- 两份答案先封存，再用看不到条件名的 judge lane 评分；
- Luna：`gpt-5.6-luna / low`；
- CPU-only、严格串行；
- 组装不调用模型、不使用 gold；
- 门槛：task 点提升、单侧 exact McNemar `p<=0.10`、authority 不退化、mean token 压缩至少 25%、CPU p95 小于 100ms；
- 只有全过才允许 Sol。

## 结果总表

| 冻结门 | 状态 | Raw task | Candidate task | Raw authority | Candidate authority | Token 压缩 | task discordant | p | SolEligible |
|---|---|---:|---:|---:|---:|---:|---|---:|---|
| v1 | 初始来源分组证据阶梯 | 75.00% | 59.38% | 84.38% | 71.88% | 35.20% | 2 胜 / 7 负 | 0.98047 | false |
| v2 | 时间序 + 风险路由 + 证据恢复 | 81.25% | 78.13% | 90.63% | 93.75% | 45.81% | 2 胜 / 3 负 | 0.81250 | false |
| v3 | v5.2 最小事实回答 + 直接个性化建议 | 75.00% | 81.25% | 81.25% | 90.63% | 47.90% | 6 胜 / 4 负 | 0.37695 | false |

## v1 失败与修正

失败不是简单的 recall 数量不足：

- 按 USER/TOOL/ASSISTANT 分组破坏时间顺序；
- 所有用户话都进入 authority spine，旧偏好、流程闲聊与当前情境竞争；
- 助手消息中承载的检索证据被当成低权重历史而漏掉；
- 客观事实问题仍看到用户喜欢的错误叙事。

对应修正：保持 ledger 时间序；加入 standalone factual、situational scope、evidence decision、personalization 风险路由；事实题隔离历史；证据决策恢复证据型助手/工具块。

## v2 失败与修正

v2 已把范围控制与证据冲突任务保持到 100%，authority 总体上升；总体只剩 3 个 raw-only。失败集中于：

- 个性化答案没有直接给出一个具体活动，过度强调约束；
- 事实答案主动加入不必要细节，和 benchmark 的最小真实结论产生边界差异；
- 一个 valid-memory case 的 candidate 与 raw 语义近似，但 judge 给出不同结果，显示小样本评分噪声不可忽略。

对应修正：事实题要求 literal/minimal；个性化题要求从最强当前正偏好直接给出一个具体建议；无关 authority 语句必须与 query/current situation 有关系才进入。

## v3 最终结论

v3 的点估计达到了希望看到的方向：task `+6.25pp`、authority `+9.38pp`、token `-47.90%`。但 paired evidence 不足以证明提升：6 胜 4 负的单侧 exact McNemar `p=0.37695`。

更重要的是，candidate 的 retrieval-missing 从 `1` 增至 `5`；个性化任务从 `0` 增至 `4`。这说明 deterministic supersession/selection 仍可能把隐含偏好压错。压缩率和平均分不能覆盖这个安全缺陷。

因此冻结决定：

1. 不合并三批做显著性，因为 v1/v2 已用于诊断与调参；
2. 不进行第四批 Luna；
3. 不进入 Sol；
4. 不启用 v5.2；
5. 保留 v5.2 作为可复现实验原型；
6. 生产继续 `safe`；个性化高风险路径未来应使用显式确认状态，或在更新不确定时宽召回用户原文。

## 复现文件

- `results/evidence-ladder-luna-gate-v1-manifest.json`
- `results/evidence-ladder-luna-gate-v2-manifest.json`
- `results/evidence-ladder-luna-gate-v3-manifest.json`
- `results/evidence-ladder-luna-gate-2026-08-13T15-33-40-887Z-055560eb.json`
- `results/evidence-ladder-luna-gate-2026-08-13T15-55-27-194Z-b5d432cd.json`
- `results/evidence-ladder-luna-gate-2026-08-13T16-09-29-797Z-674b2213.json`
- `results/evidence-ladder-v5-full-cpu-20260813.json`

三批 Luna 预算分别为 `255,150`、`242,425`、`235,302` tokens，合计 `732,877`，失败调用均为 `0`。最初一次沙箱内启动在模型答案前因 Pi 无法创建 `C:\Users\XU\.pi\agent\trust.json.lock` 而失败；获准在沙箱外运行后恢复。另一次首 case 在答案生成后、评分前发现新 condition 未加入封存白名单；答案按 prompt hash 缓存，修复白名单后在同一冻结 manifest 上续跑，没有重抽样或读取 gold。

## 后续长程门：v6.1 与 v6.4

前三批短门揭示了问题，但不再适合作为多周上下文方案的主要筛选。后续协议把一个真实目标 history 埋入 8 个异项目 histories，并同时比较 raw-long、透明 rolling-extractive 与 evidence-ladder。

### v6.1 Luna：通过

- 16 个新目标，排除 216 个先前模型目标；
- raw task `50.00%`，rolling `25.00%`，candidate `62.50%`；
- candidate vs rolling 任务差 `+37.50pp`，7:1，`p=0.03515625`；
- authority：raw `62.50%`，rolling `31.25%`，candidate `81.25%`；
- token 压缩 `92.45%`，assembly P95 `39.56 ms`；
- 全部门通过，首次授权进入 Sol。

### v6.1 Sol：严格门窄失败

78 个新目标的点估计改善：task `82.05% -> 85.90%`，authority `87.18% -> 91.03%`，compression `92.65%`。但两项 paired 95% CI 下界均为 `-5.128pp`，比预注册 `-5pp` 死线差 `0.128pp`，所以 production 仍保持 safe。

失败集中在 valid-memory：自然语言偏好更新（如从 fantasy 转向 hard sci-fi、重新订阅并提高“保持知情”的权重、party 音乐改为 upbeat）未稳定进入 authority spine；`true to life` 还被误判为独立事实题。由此形成 v6.4：active domain 硬隔离、自然更新词法、隐式个性化 query profile、bounded user spine 与 dialogue-island bridge。

### v6.4 Luna v2：通过

- 16 个再次全新的目标，排除 310 个已见目标；
- task：rolling `50.00%`，raw `68.75%`，candidate `87.50%`；candidate vs rolling 6:0，`p=0.015625`；
- authority：rolling `62.50%`，raw `87.50%`，candidate `93.75%`；
- compression `90.91%`，assembly P95 `6.24 ms`；
- 96 calls，786,268 charged tokens，0 failures；`SolEligible=true`。

### v6.4 Sol v2：正式通过

- 固定 5% / 78 个再次全新的目标，排除 326 个已见目标；
- task `85.90% -> 94.87%`，差 `+8.97pp`，paired 95% CI `[+2.56,+16.67]pp`，8:1；
- authority `85.90% -> 96.15%`，差 `+10.26pp`，CI `[+2.56,+17.95]pp`，9:1；
- mean context `19,232.38 -> 1,518.64`，压缩 `92.10%`；
- candidate assembly P95 `3.89 ms`；
- 312 calls，2,970,694 tokens，0 failed calls；全部正式门通过。

最终决定：v6.4 evidence assembly 作为 production 默认，`PI_IDEA_CONTEXT_MODE=safe` 作为人工回退。短门与 v6.1 失败全部保留，不与 v6.4 新样本合并。

新增复现文件：

- `results/long-horizon-luna-gate-v2-manifest.json`
- `results/long-horizon-luna-gate-2026-08-13T19-32-59-784Z-8f30f13c.json`
- `results/long-horizon-sol-5pct-v2-manifest.json`
- `results/long-horizon-sol-5pct-e963f5d3d880-result.json`
