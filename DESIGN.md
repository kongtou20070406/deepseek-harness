# Design System — Pi-Idea Research Instrument

## Product Context

- **What this is:** Pi 的个人科研控制面。Sol 负责主对话与科学判断；模型外系统维护多个 Idea、唯一主对话、BTW 支线、Todo、证据与运行状态。
- **Primary experience:** 一个本地 Web 页面，保留普通对话的中心地位；Pi TUI 继续作为低依赖回退入口。
- **Derived view:** “推进白板”是空投的侦探白板。它只读取已经存在的结构化状态和运行事件，不写回 Idea，不进入任何模型 loop，也不消耗输入 token。
- **Not:** 通用 IDE、项目管理 SaaS、模型思维链查看器或自动改写科研目标的代理驾驶舱。

## Aesthetic Direction

- **Direction:** Research Instrument / Detective Board。
- **Mood:** 安静、精确、可信，像实验台与案件白板的结合，而不是数据大屏。
- **Authority signal:** 琥珀色只表示用户确认的 Idea 权威或明确选中态；不能装饰性滥用。
- **Avoid:** 渐变背景、发光边框、满屏指标卡、伪实时百分比、把每个区域都做成圆角卡片。

## Layout

```text
Idea rail          Main surface                         Research inspector
multiple Ideas     conversation / detective board       Idea version + Todo
new Idea / BTW     real Pi streaming + tool results      workspaces + context
status             derived progress view                worker activity + detail
```

- 左栏管理 Idea。归档只改变可见状态，不删除版本、Todo、会话或账本。
- 中栏默认是主对话；侦探白板是并列视图，不是新型 prompt。
- 右栏用于可编辑状态与可追溯细节。窄屏时变为按需抽屉。
- 每个 Idea 只有一个 active main conversation；BTW 可多个，但不能取得主控制权。

## Detective Board Contract

白板固定显示四类线索：

1. 用户确认的 P0 科学方向。
2. 当前 Todo 及“下一 loop 待实践校正”状态。
3. 主对话、BTW 支线及关联工作区。
4. 当前/最近的工具与 worker 事件。

白板不得：生成摘要、推断隐藏思维、自动创建 Todo、改变 Idea、参与检索排序、进入 P0/P1 或 assembled history。它随时可以从 registry 和事件流重建。

## Typography and Color

- UI sans: system UI / Geist fallback；代码与 token 使用 Cascadia Mono / JetBrains Mono fallback。
- Canvas `#0B0E11`; panel `#11161B`; border `#26313A`; text `#E6EDF3`; muted `#8B9AA8`。
- Idea/authority `#D6A84B`; evidence `#55C2D6`; success `#65C88A`; warning/60% `#E5B454`; error/85% `#F06D75`。
- 深色为基线，同时提供真正重设表面的浅色主题。

## Interaction Contract

- Idea 变更始终是候选 → 精确 diff → 用户确认 → 新不可变版本。
- Todo 是工作状态，不是科研权威。用户编辑后进入下一次 main loop，模型必须结合实践接受、修正、阻塞或完成，不能盲从。
- 关联工作区不等于扩大文件权限；默认工作区只决定新会话的启动位置。
- 60% 为上下文软线，85% 为死线；未知值显示未知，不能伪装成 0。
- Worker 面板合并中央 registry 中可恢复的 Workflow/worker 投影与当前 Pi 工具事件。状态更新追加审计事件；没有证据时显示空闲，不虚构进度或百分比。

## Reference Decisions

- Anthropic autonomous coding quickstart 的 sidebar/chat/artifact 三栏信息架构适合作为骨架，但 Pi-Idea 把 artifact 栏换成科研状态与证据检查器。
- cdesktop/Kanna 的本地 session 列表与明确运行状态适合多 Idea/多会话管理。
- Walnut 的同屏 task/chat/session、per-session diff 与 live worker graph 适合作为 Workflow 可视化参照，但侦探白板不进入 agent context。

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-13 | 先以 Pi extension 建立长期意图与上下文闭环 | 保留 Pi 登录、session、分支与模型体验，不 fork 核心。 |
| 2026-08-14 | 移除 `pi-claude-code-tui` | 只替换终端外观，无法承载多 Idea、Todo、diff、BTW 与推进视图，且实际视觉不符合用户预期。 |
| 2026-08-14 | Web 为主要控制面，TUI 为回退入口 | Web 能在不污染主对话的情况下显示结构化科研状态与管理操作。 |
| 2026-08-14 | 侦探白板是纯派生视图 | 服务人的理解，不服务模型；避免额外 token、摘要漂移和新的权威来源。 |
