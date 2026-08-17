# Pi-Idea CLI-first 双内核规划

日期：2026-08-14
状态：已确认并开始实现；不得直接改写历史 `IDEA.md`

## 1. 已确认方向

1. Pi-Idea 继续以 Pi 作为当前 Agent Runtime，保留 Pi 的模型登录、session、工具循环和 RPC。
2. Pi-Idea 自身形成独立的权威内核，不让科研 Idea、长期记忆和上下文语义依赖 Pi 内部实现。
3. 引入第二个独立的可组合组件内核，吸收 Cordis 的 effect/inverse、响应式依赖、局部故障隔离和可重建一致性；先做隔离 Spike，不直接把 RC 版本放进权威状态路径。
4. 当前优先交付 CLI；Web UI 暂停扩展，只保留现有代码和回归保护。
5. 后续模型测试与低成本判别优先使用 DeepSeek API。Flash 是默认控制面模型，Pro 只用于困难判断和关键验收。
6. API Key 不进入仓库、SQLite、日志、Context Manifest、任务卡或模型上下文。
7. Harness 的目标是降本增效，不是最大化模型调用；智能只用于少数高价值语义节点。
8. 模型可以提出建议、候选路线和停止建议，但没有改变 Idea Kernel、Research Frame 或科学结论的决定权。

## 2. 三层边界

```text
CLI / Pi slash commands
          |
          v
+-------------------------------------------+
| Pi-Idea Authority Kernel                  |
| P0 / Idea versions / Raw Ledger           |
| Context compiler / Workflow state         |
| Budget ledger / Evidence provenance       |
+-------------------------------------------+
          |
          +---- Component Runtime Adapter --- Cordis Spike
          |     reversible derived services
          |
          +---- Agent Runtime Adapter ------- Pi now
                                                other runtimes later
```

### 权威内核

不得热替换、不得由模型直接改写：

- 用户确认的 P0 与不可变 Idea 版本；
- Raw Ledger 与 evidence provenance；
- 权限、预算、确认记录和运行审计事件；
- Context Manifest 和冻结 Workflow Task Card。

### 可组合组件内核

允许装载、替换、禁用和回滚，但必须可从权威状态重建：

- locator index、retriever、reranker；
- context policy、continuation resolver；
- DeepSeek judge、模型路由和缓存；
- Workflow adapter、worker adapter、Obelisk adapter；
- CLI projection 和非权威状态视图。

### Agent Runtime

Pi 只负责实际模型 loop、provider 登录、session、工具调用和流式事件。Pi-Idea 通过薄适配层使用它，不把领域状态反向写入 Pi 内部私有结构。

## 3. 当前已有能力

| 领域 | 当前状态 |
|---|---|
| Idea 权威 | P0、提案、精确 diff、用户确认、不可变版本已实现 |
| 长期记忆 | Raw Ledger、loop islands、异步索引、locator、原文回取已实现 |
| 上下文组装 | production selector、dependency closure、Manifest、预算线和 safe mode 已实现并完成固定协议验证 |
| 多 Idea | registry、归档、工作区、唯一 main、BTW 数据模型已实现 |
| Todo | 用户编辑和下一 main loop 待实践校正已实现 |
| Workflow | 冻结任务卡、worker context 原语、持久运行状态已实现；真正执行引擎尚未闭环 |
| 可观察性 | 上下文、usage、工具事件、worker 状态、侦探白板已有；Web 暂停扩展 |
| Obelisk | 兼容回取层已实现，不在上下文 hot path |

当前已知缺陷：Pi 恢复已有 session 时可能产生新的活动 session ID，导致 main/BTW registry 绑定漂移；必须先修复并加回归测试。

## 4. CLI 产品面

第一版统一入口为 `pi-idea`，同时保留 Pi 内部 `/idea-*` 命令作为会话内快捷方式。

```text
pi-idea idea list|new|show|propose|diff|confirm|reject|archive
pi-idea chat main|btw|list|resume|takeover
pi-idea todo list|add|edit|start|done|block
pi-idea run start|status|logs|pause|resume|cancel
pi-idea context preview|explain|manifest|trace
pi-idea budget show|set|history
pi-idea component list|health|enable|disable|reload|rollback
pi-idea auth deepseek set|status|remove
pi-idea doctor
```

CLI 默认输出短表格；`--json` 提供稳定机器接口。所有修改命令支持 `--dry-run`；涉及 Idea、权限扩大、组件替换和付费预算提升的操作必须显式确认。

## 5. Harness Brain V1

### 三层研究状态

现有大 P0 拆分为：

```text
Idea Kernel     用户确认的最小科学对象、成功条件与禁止偷换项
Research Frame 用户确认的变量、证据标准、允许动作与停止规则
Working State  模型可自主填充的假设、任务、观察、缺口与下一动作
```

当前技术路线不再属于不可变 Idea Kernel。模型可以在 Research Frame 内修改 Working State 和选择路线，但只能以 exact diff 提议改变 Research Frame。

### 权限矩阵

| 主体 | 可以做 | 不可以做 |
|---|---|---|
| 确定性 Harness | 组装上下文、验证 schema/证据/预算、执行已授权动作、按规则暂停或回滚 | 创造科学结论、改变 Idea 或扩大授权 |
| 模型 | 填充 Working State、解释证据、提出下一动作/路线/停止建议和 Frame Proposal | 确认自己的建议、改变框架、把推测写成事实 |
| 用户 | 确认或拒绝 Idea/Frame diff、扩大权限与预算、裁决科学意义 | 无额外系统限制 |

模型输出进入 `proposal` 区，只有以下两类内容可被程序自动应用：一是对 Working State 的 schema 合法更新；二是已经满足用户预先定义验收规则的操作性状态迁移。科学结论、框架变化和 Idea 停止永不自动确认。

### 外部状态机

```text
DISCUSS -> PLAN -> EXECUTE -> VERIFY -> CONTINUE
    ^                  |          |
    |                  v          v
    +--------------- BLOCKED    COMPLETE
                         |
                         v
                     ASK_USER
```

状态主要由确定性事件推导：用户消息类型、冻结任务卡、tool result、测试结果、证据缺口、连续失败和权限需求。模型只为无法可靠归类的剩余情况提供建议；最终应用仍经过权限、证据和预算守卫。

### 自动推进边界

Harness 可以自行：

- 恢复明确的 continuation；
- 选择已有工具、读取证据、执行已授权任务；
- 在冻结 Task Card 内有限重试；
- 验证验收项、记录结果并推进 Todo；
- 在派生组件失败时降级或回滚。

Harness 必须询问用户：

- 科学对象、终点标准或路线发生实质变化；
- 需要扩大文件、网络、费用或外部系统权限；
- 证据相互冲突且会改变科学结论；
- 达到重试、费用或风险上限；
- 无法区分继续执行与重新讨论。

## 6. DeepSeek 模型路由与预算

### 默认路由

| 工作 | 模型 |
|---|---|
| 阶段分类、相关性复核、结构化 JSON、失败归因初筛 | `deepseek-v4-flash` |
| 多证据冲突、困难上下文判定、关键方案复核 | `deepseek-v4-pro` |
| 科学路线最终裁决、P0 变化 | 不自动裁决；交给主 Sol 与用户 |

### 智能调用门

每次潜在模型调用必须先通过确定性门：

```text
规则能回答？ -------- yes --> 不调用模型
已有同状态缓存？ ---- yes --> 复用结果
决策价值低？ -------- yes --> 使用保守默认值
仅剩语义歧义且会影响结果？ yes --> Flash 提建议
高权威证据冲突或关键验收？ yes --> Pro 提建议
```

禁止用额外模型处理：切块、索引、预算计算、hash、权限校验、证据来源校验、任务状态持久化、日志整理、组件依赖、回滚和常规 Todo 更新。

### 升级条件

Flash 只有在以下任一条件成立时才升级 Pro：

- 输出不满足 schema 或自相矛盾，确定性重试仍失败；
- 两条高权威证据冲突；
- 决策会触发不可逆或高费用动作；
- 固定关键验收协议明确要求 Pro。

### 预算守卫

- hot path 默认零模型调用；
- 每个 Idea、任务、自然日分别设置硬上限；
- 请求前预估 token/费用，请求后记录实际 usage；
- 状态哈希、请求哈希、模型版本相同时复用有效判定；
- 达到 80% 提醒，100% 停止自动调用；
- 预算不足时退化为保守规则并暴露 `needs_judgment`，不得静默删证据；
- 初始开发测试预算建议封顶 5 CNY，需用户最终确认。

运行时性能要求：loop 准备阶段不调用判别模型，不运行多轮审核；CPU P95 硬门为 100 ms，工程目标为 10 ms。

## 7. Cordis Spike 验收

仅选择一个非权威组件链验证：`retriever -> reranker -> context projection`。

必须证明：

1. 组件加载产生的 listener、timer、service 和缓存均可完整撤销；
2. provider 替换后只重启受影响组件；
3. 加载失败不影响权威内核和 Pi 主对话；
4. 热演化稳定后的派生状态哈希等于从最终配置冷启动重建的哈希；
5. Cordis 不读取或写入 API Key、P0、Raw Ledger 原文和确认记录；
6. 若 Spike 不通过，可以删除 Cordis 适配层而不改领域模型。

## 8. 实施顺序

### M0：恢复可信基线

- 修复 Pi session 恢复与 main/BTW 重新绑定；
- 统一 CLI/RPC 的错误码和状态输出；
- 恢复所有非付费测试全绿。

### M1：CLI 纵向闭环

- 提供 `idea/chat/todo/run/context/doctor`；
- 完成一个 Idea 从创建、主对话、自主执行到证据验收的 CLI 流程；
- 暂不扩展 Web UI。

### M2：Harness Brain 与预算判别器

- 外部状态机、continuation resolver、停止/询问判定；
- DeepSeek Flash 默认、Pro 有门升级；
- 预算、缓存、审计、脱敏和离线降级。

### M3：Workflow 执行闭环

- 冻结 Task Card、worker 启动、独立上下文、返回契约、验收和恢复；
- 主对话保留科学责任，worker 不得改 Idea。

### M4：Cordis 可组合组件 Spike

- 验证 effect/inverse、依赖重连、事务式替换和冷/热一致性；
- 通过后再决定是否成为 production component runtime。

## 9. 当前不在范围

- 新 Web 页面或进一步视觉设计；
- 让模型自动改写 P0 或确认 Idea；
- 无上限的自主 API 消费；
- 以模型摘要替代原文证据；
- 一次性迁移或 fork Pi；
- 在 Cordis Spike 通过前把权威状态放进 Cordis。

## 10. 待用户确认

1. 初始 DeepSeek 开发测试硬上限是否采用 5 CNY；
2. CLI 第一纵向闭环是否以“创建 Idea -> main 对话 -> 自动推进一个 Task -> 验收 -> Todo 更新”为验收场景；
3. Cordis Spike 排在 Workflow 闭环之后，还是提前到 M2 并行验证。
