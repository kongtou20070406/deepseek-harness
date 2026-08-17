# @deepseek-ai/dsh-goal-round-step-budget

[English](README.md) | 中文

这是面向自动 Goal Round 的模型步骤硬准入预算。插件观察 `agent/pre-step`，只在一个轮次的首批已领取消息中识别正数编号的 Goal 消息，并在模型步骤 `maxStepsPerGoalRound + 1` 派发前取消该轮次。普通用户轮次、subagent、Workflow 以及非 Goal 的工具循环均不受影响。

```yaml
- id: goal-round-step-budget
  name: '@deepseek-ai/dsh-goal-round-step-budget'
  config:
    maxStepsPerGoalRound: 32
```

`maxStepsPerGoalRound` 是必填的正安全整数。该限制统计模型请求，而不是工具调用：一次响应中的并行工具调用仍只消耗一个步骤。达到限制时，自然完成轮次的响应会被保留；只有循环试图提出下一次模型步骤时才会取消。既有 Goal Round 驱动器会观察到 parent 取消，并在 agent 空闲时暂停活跃 Goal，因此继续推进需要人类显式恢复。

该策略不增加提示词、工具 schema、摘要调用、持久事件类型或特定提供方分支。它在请求路径上的工作只有一次首步骤来源检查，之后每个拟议步骤执行一次 WeakMap 查询。卸载 Cordis 插件会移除监听器；插件加载前已经准入的轮次不会被追溯纳管。

## Model Experience

### Goal Round 步骤限制

#### What the model sees

不增加任何文本。被纳管的失控 Round 会记录既有的中止 `turn/end`，并让 Goal 进入既有的 `paused` phase。

#### Token effect

新增输入 token 为零。超过配置步骤限制的请求不会被派发。

#### KV Cache effect

不改变请求前缀。该策略阻止后续请求，而不是重写历史。

## Known Limitations and Deferred Work

- **只约束 Goal Round** —— 普通用户轮次和其他工具循环刻意不纳入此预算，其生命周期仍由 Agent loop 与调用方负责。
- **不打断已准入响应** —— guard 阻止的是下一次模型请求，不会中断在上限处已经准入的响应或工具调用。
