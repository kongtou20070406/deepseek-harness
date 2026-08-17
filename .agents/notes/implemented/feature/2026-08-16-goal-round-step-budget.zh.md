# Agent Note: Bound automatic Goal Rounds by model steps

Status: implemented

[English](2026-08-16-goal-round-step-budget.md) | 中文

## Problem

`maxGoalRounds` 限制自动 Goal Round 的数量，却不限制单个 Round 内的模型步骤。即使提示词要求模型在指定步骤数停止，模型仍可能持续发出工具调用，在持久化 Goal 保持 armed 的同时继续消耗时间与 token。提示词文本只是指导，无法在派发下一次模型请求的操作上强制执行资源限制。

## Decision

**一个独立 Cordis guard 会识别自动 Goal Round 轮次，并在模型步骤 `maxStepsPerGoalRound + 1` 派发前取消它。** `@deepseek-ai/dsh-goal-round-step-budget` 观察 `agent/pre-step`，只在轮次首批已领取消息含有正数编号的 `GoalMessageSource` 时记录该轮次，并对之后每个拟议步骤执行一次 WeakMap 查询。普通用户轮次和其他编排模式不在其范围内。必填的正安全整数配置让部署选择保持显式；Pi-Idea 将其设为 32。

取消使用既有的 `parent` 原因。agent loop 会记录成对闭合的中止轮次，Goal Round 驱动器则观察被取消的已准入尝试，并在空闲时暂停 Goal。该设计不新增 Session 事件、Goal 状态、提示词 section、工具 schema 或提供方分支。在一个既有轮次中途加载插件不会追溯认领该轮次；卸载插件则通过 Cordis effect 移除监听器。

## Verification

包测试使用脚本化适配器驱动真实 AgentLoop。它证明：需要继续请求的 Goal Round 会在配置计数处停止，普通用户轮次不受影响，恰好在计数处自然结束的 Goal Round 仍保持完成，非法配置会在加载时失败，插件 dispose 后的监听器不再执行限制。第六个集成用例挂载真实 Goal service 与 Goal Round 驱动器，并验证超额的已准入 Round 恰好派发两次请求后停止，持久 Goal 保持 `paused`、`disarmed` 且已开始一个 Round。Cordis 配置门禁验证 Pi-Idea overlay 能解析插件及其配置值；最终构建后运行时 smoke 仍是部署检查。

## Alternatives considered

**把步骤计数写入 Goal Round 提示词。** 否决：已经观察到模型会超过文本上限，而且提示词无法阻止下一次请求被派发。

**把限制加入 AgentLoop。** 否决：普通轮次没有一个共同且有依据的限制，DSH 也已经提供生命周期扩展点，可用于独立组合该策略。

**在最后一个获准步骤结束后立即取消。** 否决：这会把恰好在限制处自然完成的响应改写成中止轮次。在下一个拟议步骤上执行准入控制，既能保留成功完成，也只会拒绝超额工作。

## Consequences

自动科研执行现在具有两个相互独立的限制：Goal 拥有 Round 数量限制，guard 拥有单个 Round 内的模型请求限制。该限制不增加输入 token，并对所有模型提供方一致生效。达到限制时会暂停 Goal，而不是完成或阻塞它，因此人类可以检查证据后显式恢复。由于 `agent/pre-step` 是稳定的公共准入扩展点，该检查发生在系统提示词组装之后；上下文组装延迟仍是独立的优化目标。
