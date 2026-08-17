# @deepseek-ai/dsh-model-execution-policy

English | [中文](README.zh.md)

A lean shared execution policy for instruction-following models. It contributes one stable prompt section to every model request without a classifier or per-route branch.

```yaml
- id: model-execution-policy
  name: '@deepseek-ai/dsh-model-execution-policy'
```

The policy distinguishes read-only requests from implementation requests, defines the small set of actions that need confirmation, makes a resolved human correction final for the current ambiguity, and separates observed resource use from measured interference. It does not override a real platform denial or authorize work outside the user's requested scope.

## Model Experience

### Shared execution policy

#### What the model sees

An `Execution policy` section immediately after the persona. Each rule appears once: interpret the latest user intent, act on in-scope change/continue requests, ask only for material user choices or external/destructive expansion, treat warnings as observations until interference is measured, and keep working while useful in-scope work remains. Sol, DeepSeek, Luna, and future routes receive the same section.

#### Token effect

One short fixed section on every model request. It makes no auxiliary model request.

#### KV Cache effect

Prefix-stable across model switches while the plugin configuration is unchanged.

## Known Limitations and Deferred Work

- **Prompt-level adaptation** — model behavior remains probabilistic. Runtime sandbox, approval, tool, and Goal enforcement keep their own authority.
- **Shared wording** — the policy deliberately encodes only provider-neutral execution boundaries; provider-specific tuning remains the adapter's responsibility.
