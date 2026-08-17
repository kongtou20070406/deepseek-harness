# Agent Note: Shared lean model execution policy

Status: implemented

English | [中文](2026-08-16-shared-model-execution-policy.zh.md)

## Problem

Long research requests combine the deployment persona, project authority, Goal guidance, tool guidance, and recalled evidence. Repeating autonomy, confirmation, resource, and user-correction rules across those sections makes repeated caution appear more authoritative than the current user request. The result can be needless confirmation loops or a model treating an amendable monitor as authority over an explicit human correction.

A request-time intent classifier would add a model call, latency, cost, and another fallible decision before every productive loop. Provider-specific copies would allow the same execution behavior to drift across model routes.

## Decision

`@deepseek-ai/dsh-model-execution-policy` registers one stable prompt section at order 5 for every assembled model request. Sol, DeepSeek, Luna, diagnostic assemblies, and future routes receive identical provider-neutral wording.

The section states each general execution rule once. Read-only requests inspect and report; change, fix, continue, and resume requests perform in-scope local work and non-destructive verification. The model asks only for a material unresolved user choice or a required external, destructive, purchasing, or scope-expanding action. A current human correction settles the operational ambiguity; an amended research contract receives a new traceable version rather than inheriting the old claim.

Warnings, background processes, and resource use remain observations until measured causal interference or a current user-confirmed threshold establishes a blocker. Actual platform and tool denials remain binding. Goal and research-control prompts retain only their domain-specific authority and lifecycle rules, so the general execution policy has one model-visible home.

The policy follows OpenAI's GPT-5.6 guidance to keep prompts lean, state instructions once, define the autonomy boundary compactly, and ask only for important ambiguities. Assembly adds no classifier or route branch.

## Alternatives considered

**Repeat the rules in Goal and research-state plugins.** Rejected because long sessions amplify duplicate caution and can make it compete with the latest request.

**Maintain provider-specific policy copies.** Rejected because the desired execution semantics are shared and duplicate text can drift without improving the request decision.

**Add an LLM classifier before each step.** Rejected because intent and confirmation boundaries can be stated directly; another call adds latency, token cost, and a new source of disagreement with the acting model.

**Enforce every semantic choice in runtime code.** Rejected because code can enforce actual sandbox, tool, and Goal state transitions, but cannot determine whether a resource observation causally contaminates a scientific result or whether a user correction changes the experiment contract.

## Consequences

Every model route receives one short prefix-stable control section. The policy adds no tool, durable state, model call, route lookup, or blocking stage. Model adherence remains probabilistic, so deterministic assembly and real AgentLoop tests pin the request text while controlled behavior replays measure model outcomes. Platform enforcement and the user's requested scope remain unchanged.
