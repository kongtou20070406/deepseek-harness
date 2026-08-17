# Pi 扩展功能原子审查

> 审查日期：2026-08-12
> 目标：只提取对 Pi Idea Harness 有用的能力，不整包合并，不改变 Pi 的会话、模型或工具后端。

## 先给结论

Harness 需要借用的是 Claude Code 的**信息呈现方式**，不是它的 Agent 架构：

- 紧凑工具摘要；
- 工具结果默认折叠，`Ctrl+O` 按需展开；
- 易读但不花哨的 diff；
- 清楚、短促的 working 状态；
- `@` 引用与补全；
- 不打断主对话的二级检查面板。

Pi 原生会话树、模型调用、工具执行、登录与恢复继续保留。Idea/P0/P1、上下文编译、Luna、Sol 和权限逻辑仍由 Harness 控制。

当前 Harness 已经完成：

- 两行轻量状态组件和真实上下文组成条；
- Idea 显示“上次确认时间”而不是粗糙版本号；
- 输出速度、思考等级、Luna 状态和 Codex Bank 槽位；
- `/guide` 二级帮助；
- 会话启动时调用 Pi 的公开 `setToolsExpanded(false)`，默认折叠工具输出；
- 内置工具保留 Pi 原生 renderer，`Ctrl+O` 使用 Pi 原生展开/折叠行为。

曾实验性加入的 `transient-tools` 内置工具覆盖层已退出默认 package：它会让 Harness 偏离普通 Pi 体验，并在失败/展开状态下暴露大量命令输出。尚未完成、且应独立实现的视觉原子是：不覆盖内置 renderer 的结果摘要、简洁 diff、全局 working 文案以及 Harness 资源的 `@` 补全。

## Claude Code 风格的最小视觉合同

### 常驻区域

只保留两行，不重复 Pi 原生 footer：

```text
◆ Idea 14m前   阶段 3m前   Luna idle   思考 high   78 tok/s   Bank 5h 87% / 周 60%   ? /guide
CTX 18.4k/272k  [P0│P1│Luna│对话│系统│工具]  free 253k
```

### 工具调用

默认只显示一行结果摘要：

```text
● Read  src/context.js · 214 lines
✓ Edit  src/context.js · +18 -7
✓ Test  29 passed · 1.8s
```

失败时只把失败原因和退出码抬高；完整命令、stdout、diff 和调用参数由 `Ctrl+O` 展开。折叠是显示状态，不改变模型收到的工具结果。

### diff

V0 只做统一 diff：文件名、变更统计、有限上下文、语法色不作为硬依赖。宽终端以后再考虑 split diff。不要引入 Shiki、鼠标 hover、工具分组和全屏 renderer。

### working

只显示当前动作，例如 `正在定位调用点…`、`Luna 正在选择历史…`、`正在运行测试…`。不显示内部思维，不滚动重复日志。Pi 的公开 `setWorkingMessage` / `setWorkingIndicator` 足够实现。

### `@` 引用

使用 Pi 的公开 `addAutocompleteProvider`，候选只包括：

- Idea Space 中的 evidence/artifact；
- 可追溯的上下文快照；
- 用户明确选择的历史会话引用；
- 以后加入的 Obelisk 命中。

选择 `@` 项只产生结构化引用，不直接把整份会话塞入 prompt。引用仍必须经过上下文编译器、预算和 Manifest；P0 永远不走这条路径。

## 扩展逐包拆解

“体积”是 npm 解包大小或粗略源码规模，只用于判断维护面，不等价于运行时内存。

| 扩展 | 真正有用的原子 | 臃肿/冲突点 | 决策 |
|---|---|---|---|
| [`pi-cc-extensions`](https://pi.dev/packages/pi-cc-extensions) 0.8.54 | 紧凑工具摘要、diff 呈现、working 样式、`@` 补全、二级 context inspector | 约 0.65 MB、13k 行；renderer 子树约 9.4k 行，diff 单项约 3k 行；通过组件/原型补丁重绘 Pi，版本敏感；还带启动页、主题、鼠标、配置中心和重复 `/context` | **只参考视觉和 MIT 实现**。默认折叠/working/补全直接用 Pi API；仅为原生工具摘要写窄适配层，失败时回退 Pi 原生渲染 |
| [`pi-web-access`](https://pi.dev/packages/pi-web-access) 0.22.0 | `source_check` 的证据状态、内容哈希、精确 passage/offset；长内容放外部缓存，以 handle/切片取回 | 约 7.1 MB、22k 行；大量搜索供应商、视频、PDF、浏览器 cookie、curator Web UI 与 Harness 无关 | **不合并搜索后端**。只采用“证据工件 + hash + passage + bounded retrieval”数据合同；可作为用户可选外部包 |
| [`pi-subagents`](https://pi.dev/packages/pi-subagents) 0.47.1 | run 状态机、取消/steer、结构化结果 envelope、artifact handle、递归与能力上限 | 约 3.3 MB、65k 行；完整子 Pi、工作树、mission、schedule、watchdog、profiles、memory、FleetView；把线程变成独立 Agent | **不合并**。Luna 继续是主对话的轻量工具调用；Sol 是受授权隔离审查，不继承整套子 Agent runtime |
| `@tintinweb/pi-subagents` 0.15.0 | Claude 风格 compact notification、FleetView 的视觉层次、运行/完成/失败状态命名 | 约 1.04 MB、8.7k 行；仍是独立会话、背景 Agent、调度、记忆和工作树 | **只借 UI 语法**。以后给 Luna/Workflow 线程做只读运行面板，不采用其执行模型 |
| `@narumitw/pi-goal` 0.51.0 | 软检查点、硬上限、无进展检测、complete/blocked/wait 状态 | 约 0.29 MB、6.8k 行；自动续跑、Goal 队列和强生命周期会把科研过程变成任务机 | **不安装**。把软检查点/硬预算作为 stage 元数据的少数状态，不新增自治 Goal 模式 |
| `@narumitw/pi-plan-mode` 0.49.3 | 可逆只读模式、工具 allowlist、安全 shell 子命令验证、明确 handoff | 约 0.18 MB、4.3k 行；计划完成工具和实施 handoff 是额外强流程 | **参考策略，不合并流程**。其 deterministic shell validator 值得借鉴；以后可做可选“讨论模式” |
| `@howaboua/pi-codex-conversion` 3.0.13 | 部分 compact renderer、后台 shell 展示、按需工具 schema 思路 | npm 解包约 117 MB；替换工具方言、provider transport、prompt、compaction、Web、图片、语音、二进制 helper | **明确排除**。它改变后端，和“只借视觉”相反 |
| `pi-markdown-preview` 0.14.0 | Markdown/LaTeX 预览与 PDF artifact 导出 | 约 2.5 MB，依赖 Puppeteer/浏览器；不影响 Idea 保真 | **以后作为可选科研技能/包**，不进入 Harness 核心 |
| `@juicesharp/rpiv-todo` 2.4.0 | 小型可折叠进度面板、从会话重建状态、行数预算 | 约 0.1 MB；通用 todo 会诱导模型维护计划，而 stage/P1 已经承担当前工作集 | **不增加通用 todo 权威**。以后可把同样的面板方式用于展示 stage 实验进度 |
| [`context-mode`](https://pi.dev/packages/context-mode) 1.0.169 | 原始长输出留在 context 外；stdout/handle 返回；FTS5 + BM25/RRF；compaction 前事件快照 | 约 4.25 MB、53k 行、8 个依赖；通用路由提示和强制工具范式会与我们的编译器争夺上下文；Elastic License 2.0 | **只研究概念，不复制源码**。可用于 P2/P3 证据索引；绝不接触 P0/P1，也不成为上下文 owner |
| [`pi-lens`](https://pi.dev/packages/pi-lens) 3.8.74 | LSP/诊断、impact cascade、symbol search，适合开发验证 Workflow | 约 19 MB、138k 行；AST/LSP/tree-sitter/扫描器体系很大，属于工程质量工具而非 Idea harness | **可选 Workflow 工具**，按需触发；不合并核心 |
| `@dietrichgebert/ponytail` 4.9.0 | “不存在→复用→标准库→原生→已有依赖→最小实现”的简化阶梯 | 常驻每轮注入会耗 token，并可能把科研问题错误压成最少代码问题 | **转成动态 implementation skill**，只在工程实现/审查时触发；不常驻主 prompt |
| [`pi-background-tasks`](https://pi.dev/packages/pi-background-tasks) 2.1.4 | durable process registry、日志文件、bounded tail、status/kill、完成通知、artifact hash | 约 1.65 MB、32k 行；Fusion、delegate、child Pi、OAuth cache 等远超需求；shell 明确不沙箱 | **以后只实现 shell task supervisor 原子**，服务几小时/几天实验；不带 Fusion/子 Agent |
| `@narumitw/pi-usage` 0.50.0 | 当前 Pi OAuth 账号的 Codex 5h/周窗口、reset、credits；5 分钟缓存；紧凑状态文本 | 约 0.2 MB，但使用未文档化的 ChatGPT usage endpoint，并包含多 provider 菜单与 reset mutation | **Bank 的最佳参考**。V0 保留零依赖响应头快路径；若实际 transport 不给 headers，再只移植只读查询，不移植 reset 写操作 |

## 上下文与证据方面最值得吸收的四个原子

1. **Evidence handle**：原始网页、日志、子线程 transcript 不进入主上下文；主对话只收到 `id/hash/type/summary/passages`。
2. **精确 passage**：任何科研结论可回到来源 hash、offset 和原文片段，不能只保存模型摘要。
3. **事件快照而非全局活对象**：Workflow 获得共享快照，相关新证据用增量事件通知；需要实时状态时由主对话明确选择。
4. **按事件重新编译**：阶段开始、任务切换、新证据、即将压缩时重新选择；普通消息复用并增量更新已有包。

这些原子都位于 P0/P1 之后。P0 逐字前缀和 P1 受保护工作集不经过检索、摘要或第三方 context manager。

## Windows 上的最小安全结论

### `pi-sandbox` 不能直接解决当前机器

用户给出的 [`pi-sandbox`](https://pi.dev/packages/pi-sandbox?type=extension&page=2) 0.6.3 是真实 OS sandbox：macOS 用 `sandbox-exec`，Linux 用 Bubblewrap；read/write/edit 再由 `tool_call` 规则检查。其源码在 `process.platform !== "darwin" && process.platform !== "linux"` 时直接提示不支持，因此**原生 Windows Pi 不会得到 OS 隔离**。

Pi 官方的 Gondolin、Docker、OpenShell 仍适合以后运行不可信实验：最可靠的方式是让整个 Pi/实验进程处于 Linux VM/容器中，只挂载当前工作区。它们不适合成为 V0 的日常必经层；自定义扩展工具若仍在宿主进程执行，也不会自动被容器保护。

`context-mode` 的 subprocess “sandbox”和 `pi-background-tasks` 都不是 OS 安全边界：前者明确继承宿主文件与凭据权限，后者明确声明 shell 不受 sandbox 保护。

### 现成安全包的可取部分

| 候选 | 评价 |
|---|---|
| `@diegopetrucci/pi-permission-gate` 0.1.12 | 最小、无依赖、约 628 行；规范化路径并在 `tool_call` 询问。适合作为骨架，但主要解析 POSIX shell，Windows `Remove-Item` 等必须补充 |
| `@erichll/pi-auto-review` 0.3.4 | “确定性 hard deny → 模型 → 精确、过期、一次性 grant”的设计很好；约 3.2k 行且耦合 permission-system/TUI compatibility bridge，不宜整包引入 |
| `pi-approval-guardian` 0.8.0 | 隔离 reviewer、fail-closed、保护私密路径；但默认审查每个 bash，约 3.8k 行，token/延迟和规则都重；它自己也明确不是 OS sandbox |
| `pi-sandbox` 0.6.3 | Linux/macOS 下可选的强边界；Windows 当前不可用 |

### Harness Guard 应有的规则

不要让 Luna 成为唯一安全边界。模型会误判；真正不可恢复的操作必须由确定性规则或用户兜底。

```text
tool_call
  ├─ 明确安全、工作区内普通操作 ──────────────► 直接执行
  ├─ 硬禁止/不可恢复目标 ───────────────────► 阻止或询问用户
  └─ 工作区外、可恢复但语义模糊的变更
          └─ Luna 低成本审查
                 ├─ allow_once ─► 精确一次性 grant ─► 执行
                 └─ deny/uncertain/timeout ─────────► 询问用户
```

确定性层：

- 先解析并规范化绝对路径；Windows 还要处理盘符、UNC、junction/reparse point 和大小写；
- `IDEA.md` 与安全配置继续由现有硬边界保护；
- 普通工作区内 read/write/edit 不审批；
- 工作区外 read 默认不打断，但 SSH key、浏览器凭据、token/config 等私密路径必须由用户明确授权，不能把内容交给 Luna；
- 工作区外 create/append/小范围 overwrite 等可恢复操作才进入 Luna；
- 删除、递归删除、覆盖已有重要文件、移动目录、权限/注册表/磁盘/系统操作，不允许 Luna 单独放行；
- `Remove-Item -Recurse -Force`、`rd /s /q`、`del /s`、POSIX `rm -rf` 以及间接 shell/PowerShell 执行必须按解析后的最终目标判断；
- 对工作区根、父目录、用户目录、系统目录、盘符根和不明确 glob 一律 fail closed；
- 允许删除 Harness 明确管理的临时目录时，仍需验证最终路径位于允许根内。

Luna 审查只接收：操作类型、规范化目标、是否存在、是否可恢复、命令摘要、当前用户意图的短片段。它不读目标内容、不带工具、low reasoning、短超时。`allow_once` 必须绑定完整请求 hash，几十秒过期，只消费一次；改一个路径或参数即失效。连续拒绝触发 circuit breaker，回到用户。

这样日常工作区内开发没有额外弹窗；真正可能损坏电脑或误删资料的边界仍然可靠。

## 推荐实现顺序

### 下一小步：纯视觉，不动后端

1. 使用 Pi 公共 API 统一 working indicator 和短文案；
2. 添加 Harness `@` 补全，但所有引用仍经过 context compiler；
3. 写一个只负责显示的 native-tool renderer adapter：紧凑摘要 + bounded unified diff；
4. adapter 必须锁定/检测 Pi 版本，任何不兼容都 fail-open 回到 Pi 原生 renderer；
5. 不引入主题、启动页、鼠标、全屏、配置中心或新 prompt。

### 随后：最小安全层

1. 先实现 Windows 路径规范化与 deterministic rules；
2. 覆盖 PowerShell、cmd 和 POSIX 常见破坏操作的测试；
3. 再接 Luna ambiguous reviewer 与一次性 grant；
4. 最后提供 `/guard` 二级检查页和审计事件，不污染主对话上下文。

### 后续科研能力

1. evidence handle/passage/hash；
2. durable experiment process supervisor；
3. 可选 Markdown/LaTeX preview 与 pi-lens Workflow；
4. Sol 审查和 Obelisk 索引；
5. 只有不可信实验才进入 Docker/WSL/OpenShell。

## 可复现源码快照

源码只浅克隆到临时目录分析，未安装到 Pi。主要快照：

| 项目 | 版本 / commit |
|---|---|
| pi-cc-extensions | 0.8.54 / `d1c9b03141b3` |
| pi-web-access | 0.22.0 / `22713b7e6399` |
| nicobailon/pi-subagents | 0.47.1 / `5d158bf6c8f6` |
| narumiruna/pi-extensions | goal 0.51.0, plan 0.49.3, usage 0.50.0 / `497e1ce37fa6` |
| howaboua-pi-stuff | codex-conversion 3.0.13 / `c8aab989809b` |
| pi-markdown-preview | 0.14.0 / `ed4615a0f74c` |
| rpiv-mono | todo 2.4.0 / `641599085126` |
| context-mode | 1.0.169 / `7ee0f2982f59` |
| pi-lens | 3.8.74 / `4bbd888000ca` |
| tintinweb/pi-subagents | 0.15.0 / `c83dd82cf4a1` |
| ponytail | 4.9.0 / `2ed6c52c9d7e` |
| pi-background-tasks | 2.1.4 / `fac9e1c8e04f` |
| carderne/pi-sandbox | 0.6.3 / `de580831fb1b` |
| erichll/pi-packages | auto-review 0.3.4, sandbox 0.6.1 / `eed9e9d7cdbf` |
| diegopetrucci/pi-extensions | permission-gate 0.1.12 / `8a9aa8677cc2` |
| pi-approval-guardian | 0.8.0 / `20b5d0665023` |

## 来源

- [Pi package catalog](https://pi.dev/packages)
- [Pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi containerization documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)
- [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)
- [pi-web-access](https://github.com/nicobailon/pi-web-access)
- [pi-subagents](https://github.com/nicobailon/pi-subagents)
- [context-mode](https://github.com/mksglu/context-mode)
- [pi-lens](https://github.com/apmantza/pi-lens)
- [pi-sandbox](https://github.com/carderne/pi-sandbox)
- [pi-auto-review / pi-sandbox](https://github.com/erichll/pi-packages)
- [permission-gate](https://github.com/diegopetrucci/pi-extensions)
- [pi-approval-guardian](https://github.com/mics8128/pi-approval-guardian)
