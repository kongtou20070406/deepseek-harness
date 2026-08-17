# Pi-Idea Context Module v6.4 交付说明

日期：2026-08-14
状态：`DELIVERED / PRODUCTION DEFAULT / SAFE ROLLBACK AVAILABLE`

## 交付内容

- Pi `0.84.1` 项目本地 extension；Sol 主对话 reasoning 不限，默认启动可使用 max；
- user-confirmed Idea/stage/narrow state 与 parent hash；
- raw session 永久账本、workspace-scoped SQLite/FTS locator；
- loop-level `dialogue` / `tool-evidence` islands 与逐字 provenance；
- v6.4 risk-adaptive proof-carrying evidence compiler；
- continuation exact roots、active Idea/stage domain boundary、authority spine；
- 60% soft / 85% hard input watermarks；
- 单 worker 异步切分、索引与 WAL maintenance；
- Obelisk explicit-gap compatibility；
- 中文研究控制台：Idea、context usage、session usage、最近 Idea 变更、Workflow 状态与 assembly audit。

## 默认与回滚

默认使用 evidence assembly：

```powershell
.\start-pi.ps1 -Thinking max
```

人工回退到原生完整历史：

```powershell
$env:PI_IDEA_CONTEXT_MODE='safe'
.\start-pi.ps1 -Thinking max
```

## 采用证据

独立 Luna-low 长程门：task `50.00% -> 87.50%`（相对 rolling），authority `62.50% -> 93.75%`，相对 raw 压缩 `90.91%`，全部门通过。

固定 5% Sol/max 正式门（78 新目标）：

- task `85.90% -> 94.87%`，paired CI `[+2.56,+16.67]pp`；
- authority `85.90% -> 96.15%`，paired CI `[+2.56,+17.95]pp`；
- mean context `19,232.38 -> 1,518.64`，压缩 `92.10%`；
- candidate assembly P95 `3.89 ms`；
- 0 failed calls；所有 gate true。

本地：extension `89/89`、research protocol `58/58`。5k-block CPU benchmark：loop P95 `0.857 ms`，continuation P95 `1.260 ms`。

## 证据文件

- `FINAL_CONTEXT_ASSEMBLY_SCHEME_V3_2026-08-14.md`
- `benchmarks/bidirectional-context/results/long-horizon-luna-gate-v2-manifest.json`
- `benchmarks/bidirectional-context/results/long-horizon-luna-gate-2026-08-13T19-32-59-784Z-8f30f13c.json`
- `benchmarks/bidirectional-context/results/long-horizon-sol-5pct-v2-manifest.json`
- `benchmarks/bidirectional-context/results/long-horizon-sol-5pct-e963f5d3d880-result.json`

## 边界

Long-horizon fixture 是真实 MemSyco histories 的合成多项目组合；rolling baseline 不是 Codex 私有 compactor；Sol 自评不等于人类盲评。正式门后只增加了 production adapter 的确定性保护（外部 live tail 不重复、exact/continuation roots 强制闭包），由本地测试覆盖，没有再做第三次模型测试。
