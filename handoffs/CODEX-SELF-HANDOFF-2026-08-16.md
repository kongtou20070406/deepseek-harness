# Codex → Pi-Idea DSH 自举 Handoff

## 接管目标

继续优化 DeepSeek Harness 及其插件体系，使 Pi-Idea 以更低上下文成本、更高效率和更稳定的真实任务表现支持长期科研；同时保持每个 Workspace 独立的科学目标、证据边界和授权状态。

## 当前权威状态

### Pi-Idea Workspace

- 路径：`D:\Myfile\work space\pi-idea`
- Research State：revision 5
- Kernel v2：持续优化 DSH 与插件体系；真实任务表现优先，局部工程完成不能冒充实际改进。
- Frame v2：以 Cordis 插件增量改进 DSH，当前优先模型外长期记忆与上下文组装。

### EqOp Workspace

- 路径：`D:\Myfile\work space\equilibrium_operator_2027`
- DSH Session：`session-d87a6ace-a7d7-4562-8db7-f7d3ac5ed296`
- Research State：revision 9
- Kernel v3：完成 EqOp；编译器、DH9、MSF9、BML 和局部实验只是手段。
- Frame v2：开放寻找最终编译器，不预设候选；最终由 matched MDTA 多 seed 质量—资源比较裁决。
- Working State revision 1：A11E2 只有 PRE-GPU CPU／治理证据；没有新的 GPU、fresh、数据、优化器或 formal 执行授权。

## 本轮修复

1. `research state revision is stale`
   - 根因：最新 revision 只在内部 Manifest 中，未进入每轮模型可见的研究上下文；人类确认后模型会复用旧 revision。
   - 修复：在保持 Kernel 为输入首段的同时，将 `state-revision` 写入 `<research-context>`；工具 schema 明确从当前视图读取该值，仍保留乐观并发保护。

2. `messageTokens` 为负导致历史加载失败
   - 根因：O(1) token 投影允许旧历史产生低估漂移，后续压缩仍减去精确 shadow price，第三次压缩后跌成负数，Zod 拒绝整个历史投影。
   - 修复：带 shadow price 的 replace 后，投影下界至少为新替换消息本身的 token 数；升级 `contextBreakdown` 与 `contextPressure` state version，冷启动从 append-only 原始日志重放。
   - 真实 EqOp 日志回放：最终 `messageTokens=16143`，全程最小值 0。

3. Idea 文本出现不等于模型注意
   - Kernel 缩成科学对象、成功证据、禁止偷换项三类决策边界；Pi-Idea bundle 的独立上限为 256 token，超限显式失败。
   - Kernel 后紧邻 `task-idea-bridge`，用当前任务绑定、未决证据和下一证据动作说明本轮如何推进一条科学判据；路线、工具和流程留在 Frame／Working State。
   - 新增 `design-research-kernel` 与更新后的 `research-state-discipline` Skill；Skill 只有显式加载才占 prompt token。

4. 长历史冷扫描与 Goal 失控
   - Session 创建／追加时按每批 32 个事件异步预热 locator；请求只同步补齐尾部。
   - 新增 `goal-round-step-budget` Cordis guard；Pi-Idea bundle 的自动 Goal round 最多 32 个模型 step，普通 turn 不受限制。

5. DSH 自举与 Skill 迁移
   - 11 个 DSH 官方工程 Skill 与 15 个可移植 Codex Skill 已进入 DSH 按需 catalog。
   - 创造模式保留 PTC Code Mode SDK，并额外提供 `tool-cordis`。DeepSeek V4 Pro 在同一对话用 6 step 完成动态 host 插件的 define／run／inspect／stop／undefine／inspect，最终注册表为空；无需重启。

## 最终验证

- 最终聚焦 research context／compaction／Goal budget：27 tests passed。
- 生产 build、目标 TypeScript build、Markdown link／wrap、Agent Note format 与双语 pairing 通过。
- 76-event、多 MB fixture：冷组装 275.322 ms、立即热组装 24.149 ms、异步预热后 1.729 ms。
- 最终服务于 2026-08-16 15:21 从旧 PID 59036 切换到新 Node PID 60660；`http://127.0.0.1:3080/` 返回 HTTP 200，stderr 为空。
- 已实际注册当前用户登录触发的 `Pi-Idea DSH` 计划任务：Interactive／Limited、隐藏窗口、无限执行时限、`IgnoreNew`；注册后状态为 Ready，未为验证而二次重启服务。
- 重启后真实 Manifest：约 8.9k token、选中 1 个 loop、遗漏 0 个、组装 1.48 ms；原会话、模型和统计恢复。
- 文档总门禁此前 27/28；唯一剩余是 Windows `EPERM` 无法创建测试 symlink，提升权限复试仍相同，不是产品回归。

## 继续时的边界

- 不从本 Handoff 推导任何新实验、GPU 或科学结论授权。
- 不把“找到编译器”偷换成 EqOp 的终极目标。
- Kernel／Frame 只能经提案、精确 diff、用户确认形成新版本。
- 保留当前 dirty worktree，不回退或覆盖无关改动。
- Kernel 排序、长度和 bridge 是可检验机制，不是“已经提高科研成功率”的证据；数周真实研究对比仍未完成。

## 运行入口

- Web：`http://127.0.0.1:3080/`
- Windows 计划任务：`Pi-Idea DSH`
- 启动脚本：`D:\Myfile\work space\pi-idea-dsh\scripts\start-pi-idea-dsh.ps1`
- 当前监听进程：Node PID 60660（2026-08-16 15:21 启动；下次接管必须重新核验，不可依赖旧 PID）。
