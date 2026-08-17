# Agent Note: Bound automatic Goal Rounds by model steps

Status: implemented

English | [中文](2026-08-16-goal-round-step-budget.zh.md)

## Problem

`maxGoalRounds` bounds the number of automatic Goal Rounds but not the model steps inside one Round. A model can keep issuing tool calls after a prompt asks it to stop at a stated step count, consuming time and tokens while the durable Goal remains armed. Prompt text is guidance and cannot enforce a resource limit at the operation that dispatches the next model request.

## Decision

**An independent Cordis guard recognizes automatic Goal Round turns and cancels them before dispatching model step `maxStepsPerGoalRound + 1`.** `@deepseek-ai/dsh-goal-round-step-budget` watches `agent/pre-step`, records a turn only when its first claimed batch contains a positive-numbered `GoalMessageSource`, and performs one WeakMap lookup on later proposed steps. Ordinary user turns and other orchestration modes are outside its scope. The required positive-safe-integer config keeps the deployment choice explicit; Pi-Idea sets it to 32.

Cancellation uses the existing `parent` cause. The agent loop records the balanced aborted turn, and the goal-round driver observes the cancelled admitted attempt and pauses the Goal at idle. No new session event, Goal state, prompt section, tool schema, or provider branch is introduced. Loading the plugin during an existing turn does not retroactively claim that turn; unloading it removes the listeners through Cordis effects.

## Verification

The package test drives a real AgentLoop with a scripted adapter. It proves that a Goal Round requiring another request stops at the configured count, an ordinary user turn is unaffected, a Goal Round that naturally finishes exactly at the count remains completed, invalid config fails at load, and disposed plugin listeners no longer enforce the limit. A sixth integration case mounts the real Goal service and Goal Round driver and verifies that an over-budget admitted Round stops after exactly two dispatched requests and leaves the durable Goal `paused`, `disarmed`, with one Round started. The Cordis config gate verifies that the Pi-Idea overlay resolves the plugin and its configured value; final built-runtime smoke remains the deployment check.

## Alternatives considered

**Put the step count in the Goal Round prompt.** Rejected: the observed model can exceed a textual cap, and a prompt cannot prevent the next request from being dispatched.

**Add the limit to AgentLoop.** Rejected: ordinary turns do not share one justified limit, and DSH already provides lifecycle extension points for an independently composed policy.

**Cancel immediately after the final allowed step ends.** Rejected: that would rewrite a response that naturally completes at the limit into an aborted turn. Admission control on the next proposed step preserves successful completion while denying only excess work.

## Consequences

Automatic research execution now has two independent bounds: the Goal owns the number of Rounds, and the guard owns model requests within one Round. The limit adds no input tokens and applies identically to every model provider. Reaching it pauses rather than completes or blocks the Goal, so a human can inspect the evidence and explicitly resume. The check occurs after system-prompt assembly because `agent/pre-step` is the stable public admission extension point; context assembly latency remains a separate optimization target.
