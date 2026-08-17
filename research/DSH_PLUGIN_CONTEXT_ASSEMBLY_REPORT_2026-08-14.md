# Pi-Idea × DeepSeek Harness：上下文组装模块交付报告

日期：2026-08-14
状态：`PLUGIN VERTICAL SLICE IMPLEMENTED / CPU + REAL PROFILE COMPOSITION VERIFIED / NO MODEL OR GPU RUN`

## 0. 结论

Pi-Idea 的第一条 DSH 上下文闭环已经实现，不再只是“配置一个 P0 再做词法召回”：

1. 原始对话、工具证据、科研状态、Goal 与每次组装决定都进入 DSH append-only Session log；
2. Idea Kernel 与 Research Frame 是带 hash、版本和确认时间的用户权威状态；
3. 模型可以提出完整 Kernel／Frame 候选，但不能确认；只有用户执行精确 `/research confirm <proposal-id>` 才会成为新版本；
4. 模型可以维护非权威 Working State：当前任务、未决项、下一动作、原始 evidence roots；
5. 每次 step 1 以前，程序用“当前问题＋Working State＋DSH Goal”检索完整历史 loop；
6. “继续做”不再只靠两个字做相似度猜测，而是沿 Working State evidence roots 和 Goal 恢复旧 loop；
7. 视图逐字以 Kernel 开头，随后才是 Frame、Working State、Goal、完整历史 loop 与 locator；
8. Kernel＋Frame＋Working State 必须落在有效路由窗口的 1/20 内；权威层和入选 loop 都不会静默截断；
9. 选择结果先记录为 `research/context-assembly`，再通过标准 compaction 事件变成 model surface；
10. DSH 原 ContextMeter 内加入同风格明细，不造第二套上下文 UI；它读取的就是上述持久 manifest projection；
11. 全部实现为 Cordis sibling plugins，没有修改 AgentLoop、Session、模型 provider 或 ContextMeter 的业务计算；
12. 热路径不调用模型、Obelisk、数据库或远程 API，只做增量索引、字符串匹配和 token 估算。

所以目前的核心不是“替长对话做一份更好的摘要”，而是：

> 用 append-only 账本保存真相，用窄权威状态表达研究方向，用一次性 evidence view 编译当前请求；缓存随时可丢，模型表面有界，任何可见内容都能回到 Session 事件。

## 1. 交付位置

| 对象 | 位置 |
|---|---|
| DSH fork 工作树 | `D:\Myfile\work space\pi-idea-dsh` |
| 状态与组装 service | `packages/context/research-context` |
| 模型工具＋人工确认 | `packages/context/research-context-controls` |
| model-surface consumer | `packages/compaction/compaction-research-context` |
| 原生 ContextMeter UI 插件 | `packages/client/ui-research-context` |
| 组合 bundle | `packages/bundle/pi-idea-context` |
| DSH 实现决策 | `.agents/notes/implemented/feature/2026-08-14-selective-research-context-surface.md` |
| 本报告 | `D:\Myfile\work space\pi-idea\research\DSH_PLUGIN_CONTEXT_ASSEMBLY_REPORT_2026-08-14.md` |

改动当前在本地 DSH fork 工作树中，尚未提交或推送。

## 2. 为什么选择 DSH 的两个独立内核

Pi-Idea 不应取代 DSH，也不应把科研语义硬编码进 AgentLoop。

### DSH Runtime Kernel

负责：

- Cordis 插件生命周期与依赖重连；
- AgentLoop waterfall；
- append-only Session；
- compaction surface；
- Goal、工具、模型 provider；
- projection 与 Web slot。

### Pi-Idea Research Kernel

负责：

- 研究者确认的 Idea Kernel；
- 当前用户确认路线 Research Frame；
- 非权威 Working State；
- 完整 loop locator；
- 当前任务驱动的 evidence view；
- 权威预算、来源与 manifest。

二者的连接点全部是 DSH 已有 seam：Session events、`agent/pre-step`、CompactionEngine、Goal service、Session projection、client slot。这样 Pi-Idea 插件可以卸载、替换或失败，而不把 DSH 核心改死。

## 3. 实际插件树

```text
dsh-base
  ├─ Session / SessionProjection / TokenMeter / Goal / AgentLoop
  └─ pi-idea-context overlay
       ├─ research-context                    [状态、索引、选择、manifest]
       ├─ research-context-controls           [模型提案、Working State、人工确认]
       └─ client-ui-research-context          [ContextMeter 内部明细]

Web standard/code preset
  └─ compaction-research-context             [隔离 Agent 域唯一 compactor]

Headless CLI
  └─ pi-idea-headless overlay
       ├─ compaction-basic                    [禁用]
       └─ compaction-research-context         [根域唯一 compactor]
```

真实 Web 与 headless `--dump-default-config` 合成都已验证。Web 只在 standard/code preset 的隔离 Agent 域选择 research compactor；headless 通过独立、可卸载的 `pi-idea-headless` 层禁用根域 basic compactor 并插入 research compactor，避免 Web 同时运行两个组装器。最初尝试“同 id 换 package name”会被 DSH name-mismatch 保护拒绝，现采用正确的“禁用旧 provider＋新增 sibling provider”。

## 4. 持久数据与可丢数据

### 4.1 永久事实：Raw Session Ledger

继续由 DSH 保存：

- `turn/start` / `turn/end`；
- 用户消息；
- assistant 消息；
- tool call / tool result；
- request、step、compaction 事件；
- `goal/change`；
- `research/state-change`；
- `research/context-assembly`。

本模块不删除旧事件，也不改写旧事件。模型表面不再显示某段历史，不等于历史被删除。

### 4.2 窄权威状态：Research State

每个 `research/state-change` 都保存完整新状态，而不是在可变文件上原地打补丁：

```text
revision
kernel { version, text, sha256, confirmedAt }
frame? { version, text, sha256, confirmedAt }
working? {
  revision,
  currentTask,
  unresolved[],
  nextAction,
  evidenceRoots[],
  updatedAt
}
proposal? {
  id,
  target: kernel | frame,
  baseHash,
  text,
  hash,
  proposedAt
}
```

权威关系：

```text
Kernel / Frame     用户确认的研究权威
Working State      模型可维护的执行状态，不是科学决定
Proposal           未确认候选，不进入模型上下文
Raw events         可追溯事实，不自动升级为研究权威
```

包级 invariant 独立回放 revision，检查首次操作、连续版本、Kernel／Frame／proposal 的 hash，以及 manifest 是否引用更早的事件。

### 4.3 检索单元：完整 Closed Turn

切分不调用模型：

- `turn/start` 到匹配的 `turn/end` 才形成候选；
- 用户文本标为 `USER`；
- assistant 输出标为 `ASSISTANT`；
- tool result 标为 `TOOL EVIDENCE`；
- tool call 参数不单独展开进长期检索文本；
- 插件派生 user message 不再索引，防止 evidence view 递归吃自己；
- 未闭合 turn 不进入长期候选。

也就是说，目前一次 loop 产出一个完整块；块内部区分 dialogue 和 tool evidence。它优先保证因果完整，不把一句话和工具结果切成失去父关系的小碎片。

### 4.4 可丢缓存：Incremental Locator Index

每个 live Session 的 WeakMap 缓存只含：

- 扫描到的 event 水位；
- 已闭合 loop；
- 当前未闭合 loop；
- 每个 loop 的词项和 raw seq。

它不是持久真相。插件卸载、进程退出或 Session 释放后可以消失；冷恢复会从 raw log 重建。测试已验证新 Context＋新 service 可恢复 Working State 和 evidence root，并召回原始 loop。

## 5. 当前问题如何变成检索查询

程序并不知道未来。它等当前问题已经被 DSH 下游插件准入、但还没发送给模型时，构造：

```text
Q_t = 当前 request messages
    + Working State.currentTask
    + Working State.unresolved
    + Working State.nextAction
    + 当前 Goal.objective
    + 当前 Goal.phase
```

然后做 NFKC 归一化，提取英文／数字／路径／标识符、连续中文和中文双字词。

更早 loop 的评分：

```text
hard root     = turn ∈ WorkingState.evidenceRoots ? 1,000,000 : 0
lexical score = 16 × overlap(Q_t, loop)
              +  2 × overlap(Kernel + Frame, loop)
              + 很小的时间近因项
```

入选条件：

- 最近 `recentTurns` 个完整 loop 无条件保留；
- 更旧 loop 必须匹配当前查询，或者是显式 evidence root；
- Kernel／Frame 相似只能二级排序，不能单独让泛化“科研”历史塞回来；
- 达到 `maxEvidenceTurns` 停；
- 没有 hard roots 时，查询词覆盖充分可提前停；
- 加入整块会超字符或 token 上限时，整块不加入，不截半块。

这解释了“它为什么能自动找历史”：不是模型提前预知，而是当前输入把检索意图显式化；若输入太弱，则由持久 Working State／Goal 提供 continuation key。

## 6. “继续做”到底发生什么

只有“继续做”两个字时，纯向量或词法相似度都不可靠。当前机制按以下顺序消歧：

1. 当前 Session 的 Goal 给出长期 objective；
2. Working State 给出当前任务、未决项与下一动作；
3. `evidenceRoots` 给出必须恢复的原始 turn；
4. 最近完整 loop 提供短程连续性；
5. 这些内容共同成为查询，必要时再选其他旧 loop。

因此 Goal 模式确实更容易组装上下文：它把“继续哪个任务”从隐含语义变成显式状态。Goal 仍由 DSH 自己的 event-sourced service 管理，Pi-Idea 只消费，不复制第二套 Goal 状态机。

如果既没有 Goal、Working State 也没有近期上下文，程序不会假装知道“继续什么”；这是需要模型向用户确认或暴露卡点的真实信息不足。

## 7. 从用户发出问题到多个 loop 结束

### 7.1 用户输入与 waterfall

1. DSH claim 用户输入并开始 turn；
2. AgentLoop 发出 `agent/pre-step`；
3. Pi-Idea consumer 先 `next()`，得到其他插件最终准入的 messages；
4. 若下游 reject、signal 已取消或 `step !== 1`，本轮不重组；
5. step 1 读取当前 Goal 和 Research State。

### 7.2 状态与索引恢复

1. 若 Session 没有研究状态，追加第一条 `initialize` 事件；
2. 若已有状态，从最新 whole-value event 恢复；
3. locator index 只扫描上次水位以后的新事件；
4. 只在 `turn/end` 后封口新 loop。

### 7.3 选择与组装

1. 构造 `Q_t`；
2. 解析 Working State hard roots；
3. 取 recent loops；
4. 对 older loops 做有界选择；
5. 逐字写 Kernel，保证它是视图第一个字符；
6. 写 confirmed Frame；
7. 写 Working State 和当前 Goal；
8. 以原始历史顺序写入完整 loop 与 `source-seqs`；
9. 用 turn ranges 写 omitted locator；
10. 通过 TokenMeter 估算每个组件和总视图 token。

### 7.4 预算

```text
authority = Kernel + Frame + Working State
authority_limit = known_context_window / 20
```

路由窗口还没在 Session 中出现时，使用 `fallbackAuthorityTokens=4096`。权威超限直接报错，不截断。完整 evidence view 另受 `maxViewChars` 和 `maxViewTokens` 约束；默认均为 48,000 量级。

60% 软线／85% 死线仍属于未来完整 request budget policy：它必须把 system prompt、tool schemas、当前输入和输出预留也算入，而不能只由 research plugin 假装掌握全请求。当前实现先落实了最关键的 1/20 authority 硬约束和独立 view 上限。

### 7.5 记录 manifest

请求前追加：

```text
research/context-assembly {
  stateRevision,
  currentTurn,
  selectedTurns,
  omittedTurnCount,
  sourceSeqs,
  estimatedTokens,
  assemblyMicros,
  components: kernel/frame/working/goal/history/locators,
  goalId?
}
```

`sourceSeqs` 包括研究状态 event、当前 Goal event 和物化历史 event。UI、回放和调试都读这一份决定。

### 7.6 提交 model surface

空 surface：把 plugin-sourced research view 放在当前问题之前。

已有 surface：追加标准事务：

```text
compaction/start
compaction/summary
user/message      surfaceOp = replace
compaction/end
```

旧事件仍在 log 中，只从本轮 `deriveMessages()` 的表面被遮蔽。若组装或替换失败，consumer 记录 warning 并保留普通完整 DSH surface；失败方向是“少压缩”，不是“丢问题”。

### 7.7 工具 step 与下一轮

- step 2、3……不重新组装，保留刚产生的 tool call/result 连续链；
- `turn/end` 后，本轮 dialogue＋tool evidence 成为下轮可检索的新完整块；
- 下一轮 step 1 再生成新的一次性 evidence view；
- manual/overflow compaction 也会记录同样 manifest。

## 8. 小型真实实例

### 历史 Loop 1

用户：

> Pi RPC 的 proper-lockfile 为什么报错？

Agent 检查进程与锁文件，tool result 给出锁拥有者和恢复路径，最终结论是旧进程留下了不一致锁状态。完整 Loop 1 以原始 seq 保存。

### 历史 Loop 2

用户：

> UI 颜色先别做。

这是局部切换，与锁恢复无关。

### 状态更新

模型通过 `update_research_working_state` 写入：

```text
currentTask: 继续处理 proper-lockfile 锁冲突
unresolved: 需要恢复 Loop 1 的锁证据
nextAction: 检查恢复路径
evidenceRoots: [1]
```

Goal 仍是“恢复可靠的长期研究循环”。

### 新问题

用户只说：

> 继续做

程序组装出的模型输入近似：

```text
[Idea Kernel 原文，位于第一个字符]
<research-context authority="user-confirmed">
  <research-frame>...</research-frame>
  <working-state authority="model-maintained">
    current-task: 继续处理 proper-lockfile 锁冲突
    unresolved: 需要恢复 Loop 1 的锁证据
    next-action: 检查恢复路径
    evidence-roots: 1
  </working-state>
  <active-goal id="...">恢复可靠的长期研究循环</active-goal>
  <historical-loop turn="1" source-seqs="...">
    USER: Pi RPC 的 proper-lockfile 为什么报错？
    ASSISTANT: ...
    TOOL EVIDENCE: 锁拥有者与恢复路径...
  </historical-loop>
  <historical-loop turn="2" source-seqs="...">...</historical-loop>
</research-context>

当前用户问题：继续做
```

Loop 1 因 hard root 恢复；Loop 2 因 recent policy 保留。模型不需要从“继续做”猜任务，也没有把旧工具证据摘要成不可追溯的一句话。

## 9. 模型与用户分别能做什么

### 模型允许

- `get_research_state`：读完整状态；
- `update_research_working_state`：整体替换执行状态；
- `propose_research_authority`：提出完整 Kernel 或 Frame 候选。

### 模型不允许

- 确认或拒绝自己的权威提案；
- 直接修改已确认 Kernel／Frame；
- 把实验结果、摘要或工程完成自动升级为 Idea；
- 用超预算截断偷换权威内容。

### 用户控制

- `/research`：查看当前权威、Working State 和 pending proposal；
- `/research confirm <proposal-id>`：确认精确候选；
- `/research reject <proposal-id>`：拒绝精确候选。

命令展示完整 before/after 文本与 hash。当前是命令行整体值确认，不是富文本逐行编辑器。

## 10. ContextMeter 可视化

没有新建第二个上下文页面。实现方式是：

1. `ui-conversation` 在原 ContextMeter panel 内声明通用 `conversation.context.details` list slot；
2. `ui-research-context` 注册一个 projection-backed entry；
3. entry 使用原 DSH CSS variables、字体、间距和弱化文本；
4. 展示 Kernel、Frame、Working State、Goal、history、locator 的近似 token；
5. 展示选中／省略 loop 数和本地 assembly latency；
6. 子线程显示父级命中 loop、本线程保留 loop、总 token 与继承组装耗时；
7. 没有 manifest 时不显示；打开面板不产生模型 token。

因此“上下文总占用”和“Pi-Idea 这次具体组装了什么”位于同一个原生弹层，但仍由不同插件拥有。

## 11. 验证结果

### 已通过

| 验证 | 结果 |
|---|---|
| 新增 host 包 TypeScript build | 通过 |
| 两个 client 包独立 typecheck | 通过 |
| focused Vitest | 最新增量 4 files / 28 tests 通过 |
| 权威提案未确认不生效 | 通过 |
| 精确确认后生成新权威版本 | 通过 |
| “继续做”沿 evidence root 召回旧 loop | 通过 |
| 冷 service 重建状态与 locator | 通过 |
| 1/20 authority 预算超限拒绝 | 通过 |
| raw event 在 surface replacement 后仍存在 | 通过 |
| manual compaction 记录 assembly manifest | 通过 |
| ContextMeter generic detail slot | 通过 |
| research UI projection 渲染 | 通过 |
| client bundles | 通过 |
| workspace constraints | 通过 |
| Cordis config 校验（122 个文件） | 通过 |
| package invariant contract（225 个包） | 通过 |
| runtime dependency closure | 通过 |
| export JSDoc、双语 pairing、README contract | 通过 |
| 真实 Web profile `--dump-config` | 三个 host 插件进入树；standard/code preset 选择 research compactor |
| 真实 headless profile `--dump-default-config` | basic compactor 禁用；根域只插入 research compactor |

未运行模型或 GPU；没有重复 Sol 配对门，也没有调用用户提供的 DeepSeek API。`verify-node-next-types` 未作为本次有效 gate，因为当前工作树缺少大量上游包的全仓 build outputs；新增包的目标 typecheck 和 bundle 已独立通过。

先前 5,000-loop 原型的 CPU 测量已经证明热组装低于 10 ms、冷扫描低于 100 ms。本轮遵守“不重复大测”的约束，没有重新跑模型 benchmark；运行时会把每次真实 `assemblyMicros` 直接写进 manifest 和 ContextMeter，后续以真实工程分布观察，而不是在关键路径增加审查器。

## 12. 当前选择与排除规则

高权重：

1. Kernel：硬保留、首部、不可摘要；
2. confirmed Frame：硬保留；
3. Working evidence roots：硬召回；
4. 当前 Goal：硬进入查询和视图；
5. 当前问题词项重叠：旧证据主要排序信号；
6. 最近闭合 loop：短程连续性；
7. authority 词项重叠：只作二级排序。

排除或降级：

- pending proposal：不进入视图；
- plugin-derived context：不回灌长期索引；
- 未闭合 turn：不进入旧证据候选；
- tool call 参数：不单独长期物化；
- 无当前查询重叠、无 evidence root、又不在 recent window 的旧 loop：只保留 locator；
- 超预算 loop：整块不选，不截断；
- 摘要：热路径不生成。

## 13. 真实工程环境下仍需继续解决的部分

1. **完整 request 水位**：把 research view 与 system prompt、tool schemas、当前消息、输出预留统一纳入 60% 软线／85% 死线；这应由更高层预算 provider 负责。
2. **极长单 turn**：当前宁可整块不选。后续可在 loop 内建立 dialogue／tool-evidence 两个子定位符，但命中任一必须恢复 parent bridge，不能出现无因果碎片。
3. **语义错词召回**：现有 lexical＋root 机制不会解决所有跨术语引用。下一步应是可替换 retrieval provider，而不是在关键路径塞总结模型。
4. **Obelisk 兼容层**：适合做异步、可选、非阻塞的历史 locator provider；它不应介入主循环权威状态，也不应在不可用时卡住请求。
5. **Idea 初始化 UX**：bundle 目前用 profile seed 建立首版权威；最终需要自然语言候选＋用户二级确认，而不是要求用户编辑 YAML。
6. **历史 manifest 浏览**：ContextMeter 当前只显示最新一次；完整时间线可由 Session event inspector 展示。
7. **Worker 结果回流合同**：父到子的选择性继承已实现；子线程结果目前仍走 DSH 原生 settlement/report，下一步需要把采纳结果记录成带 child/session 来源的候选证据，且不能自动提升为 Kernel／Frame 权威。
8. **冷父 Session 补载**：当前沿本地已加载 `parentSession` 链找到根研究 Session；根来源不在 Session store 时保留普通子线程表面，不伪造继承。
9. **数周真实科研验证**：当前证明了机制、恢复、装配与边界，没有宣称已经证明多周科学任务表现优于 DSH 滚动摘要。

## 14. 父子线程上下文继承

主模型仍只调用 DSH 原生 `subagent` 并填写短任务，例如“核对 proper-lockfile 恢复路径”。它不生成长任务包。子线程 step 1 前发生：

1. 从 child Session header 读取 `parentSession`，沿谱系找到顶层研究 Session；
2. 用子线程当前短任务查询父级 `assemble()`，召回 Kernel、Frame、Goal、Working State 和相关完整历史 loop；
3. 用 `assembleWorker()` 加入子线程自己的相关完整 loop 与当前请求；
4. 逐字以父级 Kernel 开头，通过标准 compaction checkpoint 写入 child surface；
5. `research/context-inheritance` 分开记录父级 source seq、子级 source seq、两侧 selected turns、预算、耗时和视图哈希；
6. 子线程不会初始化一份独立的 Idea 权威，也不会复制父对话全文；
7. 后续工具 step 继续使用同一表层，下一 turn 再按新请求重组。

因此父子任务包现在是 Harness 编译产物，而不是主模型输出文本。DSH 仍负责线程创建、后台运行、继续、打断和 settlement；Pi-Idea 只接管模型可见上下文。

## 15. 最终一句话

> 当前问题先经过 DSH 的正常准入；Pi-Idea 从 append-only Session 回放已确认研究权威和执行状态，用“问题＋Working State＋Goal”选择完整证据并通过标准 compaction surface 交给主模型；创建子线程时，Harness 再用短子任务从父级选择必要上下文，与子线程自身 loop 合并成可追溯继承视图，主模型不生成长任务包，缓存随时可丢，用户不确认的路线和 worker 结果永远不会自动变成权威。
