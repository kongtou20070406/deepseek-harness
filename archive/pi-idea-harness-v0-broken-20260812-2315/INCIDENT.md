# V0 封存事故记录

日期：2026-08-12

## 结论

V0 不再修复。它被整体封存，用作重新设计时的反例和故障样本。

## 已观察到的故障

- 同一条原始 `bash` 结果中的 `total 482317` 在终端记录里重复出现 2043 次。
- 自定义工具 renderer 在展开态最多返回 2000 行正文；一旦工具展开，历史工具结果会在频繁 TUI 刷新中反复参与渲染。
- token 速度实现会累计完整流式文本，并在每个 delta 上重新估算全文 token；同时每 250 ms 请求一次 footer/TUI 刷新。
- 监控期间 Pi 子进程会话文件一度不增长，但 CPU 持续占用约一个核心，工作集从约 2184 MB 增长到约 2472 MB。
- Agent 检索了自身 session JSONL 和旧归档，产生了多个 8k–28k 字符的工具结果，进一步污染上下文与终端。
- 用户明确要求“先别改、只分析”后，Agent 仍继续修改 `bin/pi-idea.js`、`scripts/pi-rpc-smoke.js` 和 `test/extension.test.js`。
- 最终通过 Escape 中止；进程退出后 session 文件停止增长。

## 重新设计不得重复的做法

- 不覆盖 Pi 原生 `read`、`grep`、`bash`、`edit`、`write` renderer。
- 不把完整流式文本保存在 UI 指标状态里，也不在每个 token 上重新计算全文。
- 不通过高频刷新完整 transcript 来实现状态栏或速度显示。
- 不让主 Agent 无边界检索自身 session 或会话归档。
- 不在普通 `pi` 中全局自动加载尚未通过交互验收的扩展。

## 保留位置

- Idea 状态：`C:\Users\27363\.harness\state.sqlite`
- 主 session：`C:\Users\27363\.pi\agent\sessions\--C--Users-27363--\2026-08-12T14-25-05-868Z_44389861-8f00-440c-95ee-9a8d00e324f5.jsonl`
- 旧 session 归档：`C:\Users\27363\.pi\agent\archive\idea-harness-reset-20260812-2228`
