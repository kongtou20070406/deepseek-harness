# Pi Idea Harness 上下文组装

更新时间：2026-08-12

这份文档描述当前代码已经实现的行为。未来设想会明确标注，不能把路线图误当成现状。

## 零、对话层级

Harness 不把整个 Pi 变成一个 Idea。`pi` 创建普通原生对话，不组装 P0/P1；`pi-idea <IdeaSpace>` 或 `pi --idea` 才进入 Idea 对话。Idea 对话本身仍是 Pi session，只是 session binding 后面连接 Idea Space 的状态、证据和上下文编译器。通过 Pi `/resume` 打开已经绑定的 session，也会自动恢复这层服务。

## 一、设计原则

1. **Idea 是不变量，不是摘要。** P0 是用户确认的科学对象、终点标准和当前路线。每次模型调用都把 P0 逐字放在第一条用户消息最前方；任何摘要器、检索器和模型都无权改写它。
2. **阶段状态与历史记忆分离。** P1 是短小、受保护的当前阶段工作集；Pi 原生 compaction summary 是可丢弃、可递归改写的非权威历史。
3. **只维护一套历史摘要。** 主对话只使用 Pi 原生 compaction；Luna 快照不再注入，也不替换会话历史，避免两份记忆互相矛盾。
4. **先保持方向，再压缩细节。** 事实、假设、冲突、实验操作、决定和开放任务必须分开。过时操作细节可以降成复现指针；反面证据和未解决冲突不能被“顺滑地总结掉”。
5. **提前整理，不等溢出。** 默认在实际 context usage 达到窗口约 40% 后，于 `agent_settled` 异步请求 Pi 原生 compaction。Pi 自带的临近窗口压缩只是最后兜底。
6. **所有压缩都可审计。** Pi JSONL 保留原始历史和原生 compaction entry；Harness 只登记摘要哈希、六类块的哈希与 token 数，不复制摘要正文。
7. **资源使用必须有界。** 不轮询、不递归遍历历史、不在 tool loop 内触发；一次摘要只线性扫描一次，索引每会话最多保留 8 代。

## 二、当前真实工程实现

### 2.1 三层输入

每次真实模型调用的逻辑输入顺序是：

```text
P0（逐字、权威）
└─ P1（短阶段集、权威）
   └─ Context Packet marker
      └─ Pi 当前分支历史
         ├─ 最近未压缩 turns
         └─ Pi 原生递归 compaction summary（若存在）
```

P0/P1 由 `src/context-compiler.js` 注入；Pi 历史由 Pi 自己构建。编译器会删除上一次 Harness 注入的 packet，防止 P0/P1 在多次 tool loop 中重复累积。

### 2.2 预算

- 有效输入预算 = 模型窗口 − 输出预留 − system prompt − tools − 安全余量。
- P0 最多占有效输入约 2%，并另设 1200 token 硬上限。
- P0+P1 合计最多占有效输入的 1/20。
- 超限时阻止调用并要求人工复盘；绝不静默截断 P0/P1。
- 每次 `context` 事件保存 Manifest：实际输入哈希、各来源 token、预算和排除原因。

### 2.3 原生语义块 compaction

Harness 通过 Pi 公共 `ctx.compact()` 触发原生 compaction，并添加研究记忆说明。摘要要求包含六个固定块：

```text
[FINDINGS]    已验证发现与来源
[HYPOTHESES]  活跃假设及状态
[CONFLICTS]   反面证据、冲突与不确定性
[OPERATIONS]  复现实验所需的命令、文件、配置和失败特征
[DECISIONS]   已作决定与理由
[OPEN_LOOP]   当前未完成任务与下一步
```

Pi 仍负责：选择旧 turn、保留最近约 20k token、递归合并上一份 summary、追踪读写文件、追加 compaction entry、恢复会话。Harness 不 fork Pi，也不维护第二份摘要正文。

### 2.4 防循环与资源上限

- 仅在 `agent_settled` 调度：此时 Pi 已没有 retry、overflow recovery、队列追问或自动继续。
- `queued` 与 `running` 双状态防重入。
- 两次调度至少间隔 5 分钟，并要求 context 水位至少再增加 8000 token。
- 软阈值为窗口约 40%，且至少 32k token；128k 模型约 51.2k，272k 模型约 108.8k。
- Pi compaction summary 输出预算配置为 8192 reserve，研究协议进一步要求摘要低于 4500 token。
- 块解析最多读取 20 万字符，复杂度为 O(摘要长度)，不遍历整个 session。
- Harness 不保存块正文，只存哈希、token、字符数；每会话只保留最近 8 代可重建索引。
- Pi JSONL 是追加式事实源，磁盘增长是线性的，不会因 Harness 复制摘要而倍增。

## 三、每次用户消息与每次 Agent loop 的时序

### 3.1 用户发送一条普通消息

1. Pi 处理输入、技能和模板。
2. Harness 在 `before_agent_start` 加入方向边界：P0 是权威科学对象，工程不能替代科学目标，原生 summary 只是非权威历史。
3. Pi 发出 `agent_start`，界面显示紧凑 working 状态。
4. 进入第一个模型 turn。

### 3.2 每一次模型调用（包括工具后的下一次 loop）

Pi 的 `context` 事件在**每次 LLM call 前**触发，因此工具循环中的第二、第三次模型调用也会重新执行以下步骤：

1. 校验 `IDEA.md` 与数据库哈希一致，拒绝带外修改。
2. 读取当前不可变 P0 与当前 P1。
3. 计算模型窗口、system、tools、输出预留和 P0/P1 上限。
4. 删除旧 Harness packet，防止重复注入。
5. 构造 `P0逐字前缀 + P1 + marker + Pi当前分支历史`。
6. 保存这一次实际输入的 Context Manifest 和哈希。
7. 将组装后的 messages 交给模型。
8. 若模型调用工具，Pi 执行工具并进入下一 loop；下一 loop 从第 1 步重新组装，所以 P0 永远重新位于最前方。

### 3.3 一条用户消息完全结束后

1. `agent_end` 只结束 working 动画，不触发整理。
2. Pi 若有重试、overflow recovery、队列消息或自动延续，先自行完成。
3. 只有 `agent_settled` 到达后，Harness 读取一次 `getContextUsage()`。
4. 未跨软阈值：立即返回，零模型调用、零后台任务。
5. 跨阈值且通过 cooldown/rearm：调用一次非等待式 `ctx.compact()`。
6. Pi 后台生成原生递归 summary，保留最近 turns，并把 compaction entry 追加进 JSONL。
7. `session_compact` 到达后，Harness 线性解析六个块，只登记有界元数据并使 ContextCompiler 缓存失效。
8. 下一条用户消息直接使用 `P0 + P1 + 新原生 summary + 最近 turns`，不需要等到窗口溢出才开始整理。

## 四、尚未实现

- 对尚在最近 20k token 内、但语义上已经无用的任意散落消息做物理删除。Pi 原生 compaction 按 turn 边界工作；过早删除会破坏工具调用与会话树一致性。
- 自动从原始 artifacts 恢复某个摘要块的全文。当前可通过摘要保留的文件/证据指针人工或由主对话读取；以后可接 Obelisk sidecar，但不能成为权威 P0/P1。
- 用长期科研基准验证“40%/20k/8k”是否最优。这些目前是有测试保护的保守默认值，后续应依据真实多周使用数据调整。
