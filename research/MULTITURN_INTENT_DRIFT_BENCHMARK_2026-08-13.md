# Pi-Idea 多轮研究意图连续性回放基准 v1

日期：2026-08-13
结论：在这套小型、确定性、CPU-only 的上下文充分性诊断里，Pi-Idea 目标架构原型 6/6 通过，滚动压缩模拟 4/6 通过；Pi-Idea 平均输入为 195 tokens，滚动压缩模拟为 818.83 tokens。随后“窄状态 + 指针 + 原文岛召回”已经接入生产扩展并通过跨会话回归，但仍不等于 Sol 下游任务表现已经非劣。

## 1. 问题与判定对象

测试不问“摘要写得像不像”，而问下一轮真正交给模型的上下文是否同时满足：

1. 已确认研究总目标仍在；
2. 当前节点、最新用户纠正、权限边界和可验证事件仍在；
3. 已明确禁止的工具调用或无依据模型猜测没有泄漏；
4. 当前用户问题恰好出现一次；
5. 在上述条件满足后，输入 token 尽可能少。

这里的 `goalDrift=true` 有严格、可复算的定义：上下文中缺失已确认总目标 marker。它不依赖另一个模型做主观打分。

## 2. 场景来源

使用 Obelisk 对既有用户历史做了有界检索，只抽取交互结构，不复制私密研究内容。观察到的真实模式包括：

- 大量只发送“继续”的回合；
- 明确推翻旧参数并给出新参数；
- 插入局部任务后返回旧主线；
- 只读、CPU-only、禁止自动扩展等权限约束；
- 工具证据、模型推断与用户授权混在邻近回合；
- 连续增加局部目标，可能挤压最初研究意图。

这些结构被匿名化为 6 个 synthetic replay。这样既能公开复现，也不会把 Obelisk 变成 Pi-Idea 热路径。

## 3. 比较条件

所有策略使用 900-token 上限。

| 条件 | 输入机制 |
|---|---|
| Rolling | 可复现的 Codex-style 模拟：最近 raw tail + 有界、可替换的抽取式滚动摘要 |
| Pi-Idea target prototype | 永久目标 anchor + 用户确认窄状态 + continuation/evidence 指针 + 完整 loop island 原文回取 |
| Retrieval-only ablation | 保留相同检索器，但拿掉窄状态和指针 |
| Full ledger | 仅用于计算 token 比例，不参与 900-token 竞争 |

Rolling 是透明基线，不声称逐字复刻 Codex 私有 compactor。Pi-Idea 获得结构化窄状态和指针并非“额外泄题”，而正是待验证架构；消融组用于判断收益是否只是来自检索器。

## 4. 结果

artifact：`research/MULTITURN_INTENT_DRIFT_BENCHMARK_2026-08-13.json`
SHA-256：`2AD12B4BB45D4E1815AB4CC2607F8C5CD7738EBB4CC0A9B42E633958E9C9486F`（连续两次生成一致）

| 条件 | 通过 | goal drift | forbidden leak | mean expected coverage | mean tokens | 占 full ledger |
|---|---:|---:|---:|---:|---:|---:|
| Rolling | 4/6 | 1/6 | 2/6 | 83.33% | 818.83 | 44.57% |
| Pi-Idea target prototype | 6/6 | 0/6 | 0/6 | 100% | 195.00 | 12.01% |
| Retrieval-only | 2/6 | 0/6 | 2/6 | 83.33% | 274.00 | 12.50% |

Pi-Idea 相对 Rolling 平均少输入约 76.19%，同时没有降低这 6 个确定性 context-sufficiency checks 的覆盖。

逐场景结果：

| 场景 | Rolling | Pi-Idea | 关键差异 |
|---|---:|---:|---|
| bare continue | fail | pass | Rolling 带入 tool-call payload；Pi-Idea 用 continuation pointer 恢复上一完整工作岛 |
| late correction | pass | pass | 两者均保留当前参数；Pi-Idea 窄状态无需携带旧参数叙述 |
| switch and return | pass | pass | 明确实体名足以触发历史召回 |
| authority and scope | pass | pass | Pi-Idea 用权限状态 + verified-evidence pointer，不召回模型猜测 |
| new constraint | pass | pass | raw retention 与当前节点由窄状态/continuation 共同维持 |
| goal crowding stress | fail | pass | 48 个局部目标将 Rolling 的最初目标挤出；永久 anchor 不受局部 recency 竞争 |

## 5. 这组测试真正说明了什么

最重要的消融结论是：只留下检索器后通过率从 6/6 降到 2/6。因而当前设计不应继续把主要精力放在“更复杂的 embedding/reranker”上。必要结构是：

```text
immutable confirmed goal
  + latest user-confirmed narrow state
  + continuation/evidence pointers
  + query-triggered full-island raw retrieval
  + current question exactly once
```

检索器负责补缺，不负责凭词面猜“继续”指向哪里；摘要也不承担永久保存目标的职责。

## 6. 边界与下一验证门

本基准存在三个明确边界：

1. 只有 6 个结构化 archetype，适合做回归门，不足以估计真实世界总体成功率；
2. marker coverage 证明“正确信息在上下文里”，不证明 Sol 一定正确使用它；
3. Rolling 是公开、透明的模拟，不是 Codex 私有滚动压缩器的逐字复刻。

因此当前产品判断是：**Pi-Idea 结构已经通过生产接线回归，但 Goal 仍未完成。** 当前扩展使用显式用户命令确认窄状态，后台 worker 持久写入 continuation/evidence frame，跨会话裸“继续”按 Idea/stage 恢复完整原文岛。下一门是已冻结 5% manifest 上的 Sol raw-vs-Pi-Idea 配对任务表现非劣验证；任务成功和 authority use 不下降后，才能把 token 优势升级为产品结论。

## 7. 复现

```powershell
cd "D:\Myfile\work space\pi-idea\pi-idea-extension"
npm run bench:intent
node --test test/multiturn-intent-drift.test.js
```

实现：`pi-idea-extension/benchmark/multiturn-intent-drift.js`
回归：`pi-idea-extension/test/multiturn-intent-drift.test.js`
