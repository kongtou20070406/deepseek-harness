# Pi-Idea Extension 0.2

Pi-Idea 是普通 Pi 对话上的长期科研控制层：主对话仍由 Sol 驱动，模型外保存原始研究账本，只为当前 loop 组装一次性证据视图。权威状态分为用户所有的 Idea Kernel、用户确认的 Research Frame，以及模型可填充但无科学决策权的 Working State。

## 当前状态

- `proof-carrying-dialogue-islands-v6.4` 已通过全新独立的固定 5% Sol/max 配对门，现为默认 production 路径。
- 显式设置 `PI_IDEA_CONTEXT_MODE=safe` 可退回“锚点 + Pi 原生完整历史”，不做选择性组装。
- raw Pi session 默认永久保存，除非用户明确要求清理；100 GiB 仅触发容量复核，不授权自动删除。
- Obelisk 是缺口回取兼容层，不进入每轮 hot path，也不是第二个事实源。

正式 Sol 结果（78 个全新目标，每个埋入 8 个异项目干扰历史）：

| 指标 | raw-long | evidence-ladder | 配对结果 |
|---|---:|---:|---:|
| task success | 85.90% | 94.87% | +8.97pp；95% CI `[+2.56,+16.67]pp`；8:1 |
| authority correct | 85.90% | 96.15% | +10.26pp；95% CI `[+2.56,+17.95]pp`；9:1 |
| mean context tokens | 19,232.38 | 1,518.64 | -92.10% |
| assembly P95 | 7.63 ms | 3.89 ms | 通过 100 ms 门 |

Manifest：`research/benchmarks/bidirectional-context/results/long-horizon-sol-5pct-v2-manifest.json`
Result：`research/benchmarks/bidirectional-context/results/long-horizon-sol-5pct-e963f5d3d880-result.json`

这证明的是固定合成长程协议上的改进，不等于自然多周科研部署已被完全解决；详情与边界见 [最终方案](../research/FINAL_CONTEXT_ASSEMBLY_SCHEME_V3_2026-08-14.md)。

## 核心机制

1. **Raw Ledger**：逐字、不可变、可追溯；用户话对意图/约束有权威，工具结果是外部证据，旧 assistant 非权威。
2. **Trusted State**：只保存用户确认 Idea、stage、窄状态、权限、已验证结果与未决 continuation；候选不会自动生效。
3. **Locator Index**：SQLite/FTS 可重建索引；每个 user-to-user loop 最多形成 `dialogue` 与 `tool-evidence` 两类 island。tool call 参数不进事实上下文。
4. **Ephemeral Evidence View**：根据当前问题、active Idea/stage、未决 roots、显式引用和来源风险逐级展开；覆盖充分即停，用后丢弃。

硬关系优先级：

```text
explicit continuation / unresolved roots
  > user authority updates and scope
  > task-related raw events
  > tool evidence
  > prior assistant history
  > lexical heat / optional reranker
```

语义上暂时不用的原文是 `LOCATOR_ONLY / RAW_LEDGER_RETAINED`，不是删除。只有 thinking、UI noise、tool-call 参数、被最终事件覆盖的中间流等具有结构证明的内容才从 prompt 排除。

## 窗口和性能

- 60% 是软线：只有证据闭包不充分才扩张。
- 85% 是完整输入死线：不能装入完整必需事件时输出 `context_gap`，禁止半条截断。
- 当前问题独立放入 Pi 的 user request；assembled history 只提供历史证据。
- 裸“继续”使用最新 continuation frame 与 exact block roots，不依赖“继续”两个字做语义检索。
- 写入侧由单 worker 串行异步切块/索引；loop 读取最后已提交快照，不等待切分，也不调用模型。

5,000 历史块、4,001 源消息、1,000 次 CPU 回归：普通 loop P95 `0.86 ms`，continuation P95 `1.26 ms`，后台 8-entry 调度 P95 `0.010 ms`。扩展测试 `89/89`，研究协议测试 `58/58`。

## 命令

```text
/idea-start <自然语言想法>
/idea-propose <自由格式候选>
/idea-confirm
/idea
/idea-stage <当前阶段；留空清除>
/idea-state-set <key=value>
/idea-state-unset <key>
/idea-state
/idea-frame
/idea-frame-confirm
/idea-working
/idea-pause
/idea-resume
/idea-manifest
/idea-context
/idea-workflows
/idea-dashboard
/idea-trace
/idea-toolbox
/idea-skills
/idea-skill-promote <候选 ID 前缀>
```

CLI-first 管理入口：

```powershell
npm run cli -- idea list
npm run cli -- idea show <idea-id>
npm run cli -- working show <idea-id>
npm run cli -- working set <idea-id> nextAction "下一动作"
npm run cli -- frame propose <idea-id> "候选 Research Frame"
npm run cli -- frame confirm <idea-id> <proposal-id>
npm run cli -- doctor --json
```

旧 P0 原文和版本继续保留。带有明确 `当前路线` 标题的旧内容会按字节边界确定性拆分；无法确定性拆分时全文暂留 Kernel 并等待用户定义 Frame，不调用模型猜测。

项目已移除 `pi-claude-code-tui`。它只替换终端外观，不能承载多 Idea、Todo、版本 diff、BTW 支线和推进白板，也没有达到实际需要的 Claude Code 交互质量。Pi 原生 TUI 保留为低依赖入口。

界面部分汉化：状态、上下文、水位、用量与 Workflow 状态使用中文；Idea、模型名、token、hash 和命令保留英文标识。Pi 原生 `Shift+Tab` 控制主 Sol 思考等级，Pi-Idea 不限制主对话 reasoning。

## 启动与回退

推荐启动本地 Web 控制面：

```powershell
.\start-pi-web.ps1 -Thinking max
```

网页由本地 Node 进程通过 Pi 官方 RPC 模式驱动，默认只监听 `127.0.0.1:43120`，复用原有 `openai-codex` 登录与 Pi session。它提供：

- 多 Idea 管理、归档/恢复和每版精确 diff；
- 每个 Idea 唯一主对话与任意数量 BTW 支线；
- 可编辑 Todo，用户修改会在下一次主 loop 中等待模型结合实践校正；
- 灵活关联、解除和选择默认工作区，但不自动扩大文件权限；
- 实时上下文/usage/工具事件，以及不进入模型上下文的“侦探白板”。
- Workflow/worker 进度保存在全局 Idea registry，刷新与恢复后仍可查看；主对话通过 `idea_workflow_status` 更新运行、等待、阻塞、完成、失败或取消状态，BTW 只读。

如只需终端入口：

```powershell
.\start-pi.ps1 -Thinking max
```

仅在需要临时禁用选择性组装时：

```powershell
$env:PI_IDEA_CONTEXT_MODE='safe'
.\start-pi.ps1 -Thinking max
```

项目本地 Pi 为 `0.84.1`。首次使用需完成 `openai-codex` 登录。session Manifest 位于 Pi data dir 的 `idea-extension/<session-hash>/`，项目索引位于 `idea-extension/projects/<project-id>/memory.sqlite`。

## 复现

```powershell
npm test
npm run test:web
npm run bench:context
```

文献与检索记录见 [allinone.md](../allinone.md)；Luna/Sol 证据链见 [门测记录](../research/EVIDENCE_LADDER_LUNA_GATES_2026-08-14.md)。旧 v3/v4/v5.x 报告保留为失败史，不代表当前默认实现。
