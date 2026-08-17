# @deepseek-ai/dsh-goal-round-step-budget

English | [中文](README.zh.md)

Hard model-step admission budget for automatic Goal Rounds. The plugin observes `agent/pre-step`, recognizes only a positive-numbered goal message in a turn's first claimed batch, and cancels that turn before dispatching model step `maxStepsPerGoalRound + 1`. Ordinary user turns, subagents, workflows, and non-goal tool loops are unchanged.

```yaml
- id: goal-round-step-budget
  name: '@deepseek-ai/dsh-goal-round-step-budget'
  config:
    maxStepsPerGoalRound: 32
```

`maxStepsPerGoalRound` is required and must be a positive safe integer. The limit counts model requests, not tool calls: parallel tool calls inside one response still consume one step. At the limit, a response that naturally completes the turn is retained; cancellation occurs only when the loop proposes another model step. The existing goal-round driver observes the parent cancellation and pauses the active goal at agent idle, so continuation requires an explicit human resume.

The policy adds no prompt, tool schema, summary call, durable event type, or provider-specific branch. Its request-path work is one first-step source check followed by one WeakMap lookup per proposed step. Unloading the Cordis plugin removes the listeners; a turn already admitted before loading is intentionally not retroactively governed.

## Model Experience

### Goal Round step limit

#### What the model sees

No additional text. A governed runaway round records the existing aborted `turn/end` and leaves the Goal in its existing `paused` phase.

#### Token effect

Zero added input tokens. Requests after the configured step limit are not dispatched.

#### KV Cache effect

No change to request prefixes. The policy prevents a later request instead of rewriting history.

## Known Limitations and Deferred Work

- **Goal Rounds only** — ordinary user turns and other tool loops are intentionally outside this budget; their lifecycle remains owned by the Agent loop and caller.
- **In-flight response** — the guard prevents the next model request. It does not interrupt a response or tool call already admitted at the configured limit.
