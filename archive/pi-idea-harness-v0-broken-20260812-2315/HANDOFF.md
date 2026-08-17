# Pi Idea Harness 开发 Handoff

更新时间：2026-08-12 22:30（Asia/Shanghai）

## 当前结论

Idea 是一种绑定 Harness 状态的原生 Pi 对话，不是覆盖所有 Pi 对话的全局工作区。

- `pi`：普通对话；package 全局加载，但不发现、不注入用户目录里的 Idea，也不替换 Pi 默认 UI。
- `pi-idea <IdeaSpace>`：显式进入 Idea，默认恢复该 Idea 的唯一主对话。
- `pi --idea`：显式激活当前目录向上发现的 Idea。
- 通过 Pi `/resume` 恢复含 `idea-harness-binding` 的 session 时自动激活。

## 活跃运行状态

实际使用的 Idea Space 是：

```text
C:\Users\27363
P0 SHA-256: 1468CE6D11E74ADAC76A8B9C8866EA321DB67571CE0143129B8C42C96324D447
```

新主对话：

```text
session id:   44389861-8f00-440c-95ee-9a8d00e324f5
session file: C:\Users\27363\.pi\agent\sessions\--C--Users-27363--\2026-08-12T14-25-05-868Z_44389861-8f00-440c-95ee-9a8d00e324f5.jsonl
name:         Idea 主对话 · 2026-08-12
```

旧两份 Idea session 已从 `/resume` 范围移出，但可恢复：

```text
C:\Users\27363\.pi\agent\archive\idea-harness-reset-20260812-2228
```

开发工作区内还存在另一份较早的独立 Idea Space：

```text
C:\Users\27363\Documents\ChatGPT\Idea
P0 SHA-256: F98C04D5D9CAC3E7F61F31E68CD2C8CBA5058F417FCE1EBF6C8DF82F2CD5A386
```

不要自动合并或删除这两个 Idea Space。用户只要求清理旧对话，没有授权删除 Idea 状态。

## 已实现

- 自由格式 P0：初始化只收自然语言，AI 整理候选，用户二级面板确认后冻结。
- P0/P1 每次 LLM call 重新注入；P0 逐字位于第一条用户消息前缀。
- Idea 修改必须“提案 → 精确 diff → 用户确认 → 新不可变版本”。
- 唯一主对话、控制租约、显式接管和返回主对话。
- Context Manifest：每次实际输入的来源、预算、token 与哈希。
- Luna 上下文快照已停用；旧数据库记录仅保留审计，不再注册刷新工具、不再注入。
- Pi 原生递归 compaction 在 `agent_settled` 后、约 40% 窗口时非等待式触发。
- 原生 summary 内六类语义块：发现、假设、冲突、操作、决定、开放任务。
- 防重入：queued/running、5 分钟 cooldown、8k token rearm；compaction 事件不会触发下一次 compaction。
- 防存储/CPU 膨胀：不复制摘要正文、解析上限 20 万字符、索引每 session 最多 8 代、一次线性扫描、无轮询线程。
- 普通 `pi` 与 Idea 对话分离；`pi-idea` 已验证恢复新主对话。
- 工具默认折叠、紧凑 working 状态、`/think`、`/usage`、`? /guide`。

## 关键代码

```text
extensions/idea-harness.js   Pi 事件、显式 Idea 激活、命令、UI、compaction 调度
bin/pi-idea.js               Idea 对话入口与主 session 恢复
src/context-compiler.js      P0/P1 精确注入、预算、Manifest
src/native-compaction.js     软阈值、块协议、解析上限、CLI session intent
src/state-store.js           SQLite 版本、事件、控制权、有界块索引
docs/CONTEXT_ASSEMBLY.md     原则、真实实现、每消息/每 loop 时序
docs/MEMORY_RESEARCH.md      长期记忆论文与实现映射
```

## Pi 原生语义块 compaction

Pi 负责 turn cut、recent tail、previous summary 递归合并、文件操作追踪和 JSONL 追加。Harness 只通过 `ctx.compact({ customInstructions })` 要求 summary 含：

```text
[FINDINGS] [HYPOTHESES] [CONFLICTS]
[OPERATIONS] [DECISIONS] [OPEN_LOOP]
```

触发挂在 `agent_settled`，不能改回 `agent_end`。Pi 文档明确说明 `agent_end` 后仍可能 retry、auto-compact 或处理 follow-up；改回去会重新引入竞态/循环风险。

## 验证状态

- 47 项 Node tests 全部通过。
- Pi 0.84.1 RPC 显式扩展冒烟通过，不调用付费模型。
- `pi-idea --mode rpc` 已确认恢复新主 session，0 条旧消息。
- `pi --mode rpc --no-session` 已确认不激活 Idea 上下文。
- 本轮前后两个 `IDEA.md` 哈希未改变。

## 尚未完成

- Luna 作为简单工作线程（不是上下文快照）。
- Workflow 与跨 Workflow 状态共享。
- 阶段/单次授权的 Sol 审查线程。
- Obelisk 只读 sidecar 与从摘要指针回看原文。
- 实验进度、证据冲突和阶段预算面板。
- Windows 工作区外高危操作 guard。
- 多周真实评测与阈值调优。

下一步不要先扩 Agent 框架。优先用真实研究对话评估：P0 稳定性、反证 recall、操作可复现性、compaction 等待时间、主模型输入 token、JSONL/SQLite 月增长量。
