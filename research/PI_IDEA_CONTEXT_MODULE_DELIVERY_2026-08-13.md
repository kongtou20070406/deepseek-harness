# Pi-Idea 上下文模块交付说明

日期：2026-08-13
交付状态：`SAFE INFRASTRUCTURE DELIVERED / AUTHORITY-V4 REPAIRED BUT NOT ADOPTED`

Authority-v4 上下文模块：`artifacts/Pi-Idea-Context-Module-2026-08-13-v4.zip`
SHA-256：`FD8C16A905138C30B78E826566276A88B55E1D4861A3BA3D023985350A80B948`

含研究控制台与 Workflow context packet 的完整 v3 插件包：`artifacts/Pi-Idea-Plugin-2026-08-13-v3.zip`
SHA-256：`8F9426FE444A9926AB6753C8CAF0D560DABF3481D8C51981861DE1DA5F47CBEE`

旧包保留用于追溯，不应作为当前安装来源。独立校验文件：`artifacts/Pi-Idea-2026-08-13-SHA256.txt`。

## 可交付能力

- Pi `0.84.1` 项目本地扩展，可用 `start-pi.ps1` 启动 Sol 主对话；
- 用户确认的 Idea、版本 parent hash、stage 与窄状态，每轮作为不可变研究锚点；
- Pi raw session 作为长期权威账本，默认永久保存，除非用户明确要求清理；
- workspace-scoped SQLite/FTS 可重建 locator index；
- 每轮 `dialogue` 与可选 `tool-evidence` 完整岛，tool call 参数不进入模型上下文；
- 跨 session capsule、Idea/stage 相容召回、裸“继续”的 continuation frame；
- block/session/entry/parent/time/raw hash provenance 与每轮 assembly Manifest；
- 单 worker 的异步切分、索引、checkpoint；热路径 CPU P95 低于 1 ms；
- cleanup dry-run、授权门与 active continuation closure 保护；
- Obelisk 兼容层只做外部历史回取，不进入热路径。

## 默认运行模式

默认 `safe`。插件只向 Pi 原生上下文前添加用户确认锚点，不删除历史：

```powershell
.\start-pi.ps1 -Thinking max
```

未采纳的选择性编译器只可显式研究使用：

```powershell
$env:PI_IDEA_CONTEXT_MODE='experimental'
.\start-pi.ps1 -Thinking max
```

不要把 `experimental` 描述为已验证的降本增效模式。

## 验证结论

- 本地扩展测试：78/78 pass；项目本地 Pi installed smoke 通过；
- fixed 5% MemSyco assembly-only：evidence body 平均减少 23.00%；
- fixed 5% Sol/max paired gate：70 个完整可评分配对；
- task success：raw 94.29%，LSC-EPC 87.14%，差 -7.14pp，非劣失败；
- authority use：raw 100%，LSC-EPC 91.43%，差 -8.57pp，非劣失败；
- 可评分子集 evidence tokens：2104.73 -> 1613.30，减少 23.35%，但因性能门失败不得采纳；
- 5 个 raw-only task regressions，主要是 `valid_memory_selection` 的漏召回。

完整结果：`research/benchmarks/bidirectional-context/results/sol-lsc-epc-5pct-88050c81911c-result-partial.json`。

失败审计后已实现 authority-v4：新增用户更新与 scope relation、supersession shadow，以及 `MATERIALIZED / LOCATOR_ONLY / EXCLUDED` 三态 Manifest；raw 始终保留。唯一一次用户授权的 1% Luna-low 难例诊断显示 task `75.00% -> 81.25%`、authority `81.25% -> 93.75%`、mean evidence tokens 减少 36.96%。该样本仅 16 条且定向包含旧回归，属于 `dev-tuned` 诊断，不替代 Sol 采纳门。全量 1,550 条零模型 CPU 回放中 v4 mean tokens 减少 31.72%，assembly P95 0.598 ms；这仍不是任务质量证据。详见 `research/AUTHORITY_CONTEXT_V4_2026-08-13.md`。

随后按用户授权完成同一固定 5% 的正式 Sol/max 复测，78/78 case 全部判完：task success `93.59% -> 91.03%`，差 `-2.56pp`，95% CI `[-6.41pp, 0]`，task 非劣失败；authority `98.72% -> 97.44%`，差 `-1.28pp`，95% CI `[-3.85pp, 0]`，authority 非劣通过；mean tokens 减少 33.76%。因此默认仍是 `safe`。同旧 v3 可比的 70 条上，v4 task 提升 5.71pp、authority 提升 7.14pp，说明修复有效，但不足以跨过产品死线。详见 `research/SOL_AUTHORITY_V4_5PCT_GATE_2026-08-13.md`。

## 已知边界

正式 Sol 盲判在 70/78 case 后遇到一个不可解析输出并按冻结合同停止；judge 不重试。剩余 8 个是固定 seeded 顺序的尾部，不能假设完全随机缺失。后续授权的 1% Luna-low 只用于难例诊断，不改变“候选不能采纳”的保守决定：正式 Sol 点估计和置信区间均越过 -5pp 门。

## 下一阶段接口

UI 可以直接消费每轮 Manifest，显示 context window 占比、soft/hard watermark、token 分解、adoption mode、Idea 版本与最后确认时间、selected/dropped/deferred block、continuation 恢复和项目索引状态。工具线程应获得独立 task card、最小工作集、证据 locator 与输出合同，不继承主对话历史；其结果只返回证据、结论与显式状态增量。此部分不再做模型 benchmark。
