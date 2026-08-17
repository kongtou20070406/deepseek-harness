---
name: dsh-self-bootstrap
description: Use when DeepSeek Harness inspects, modifies, hot-reloads, or validates its own Cordis Plugin or source while preserving the current research conversation and host process.
---

# DSH Self-Bootstrap

Make the smallest persistent change that advances the requested Harness outcome. This skill selects existing repository workflows; it does not duplicate their rules or impose them on ordinary research turns.

## Preserve the active conversation

- Never infer that a parent shell, terminal, or launcher is a supervisor. Do not call `Stop-Process`, `taskkill`, kill the port listener, terminate Node, or run the startup script from inside the served Session.
- Separate live experiments from persistent source changes. A dynamic Cordis Package is a same-process prototype; an edited repository Plugin becomes persistent only after its owning package is rebuilt and the live Loader has activated that build.
- Keep model-visible changes logged. A prompt, tool, or context contribution that reaches a request must be reconstructable from Session events.
- Treat the user's current correction as authority over amendable Working State and monitors. Preserve superseded research state as evidence instead of silently claiming the new run satisfied the old contract.

## Default route: hot-reinstall only the owning Plugin

Use this route before considering a host restart.

1. Identify one owning Loader entry and package. Record the active Session ID and the PID listening on the DSH port.
2. For an `@pluginId` dynamic Plugin, call `cordis_inspect_self(pluginId, packageId)`, append an immutable version with `cordis_define` using `plugin.kind: "existing"`, then activate the returned Package with `cordis_run` mode `"update"`. Roll back with mode `"run"` on the previous `currentPackageId`; do not create a replacement Plugin.
3. For a persistent repository Plugin, edit only its source and run the smallest package build. Normally use `pnpm exec tsc -b <package>/tsconfig.json`; when `package.json` declares `dsh.client.platform: "web"`, also run `pnpm --filter <package-name> run bundle`. Do not rebuild or reinstall the whole application.
4. Let host HMR replace the affected Loader fiber and let client-HMR replace the rebuilt browser bundle. Do not stop the Plugin first: lifecycle disposal and dependency reactivation belong to Cordis.
5. Accept the update only after the exact Plugin reports a successful reload, the requested behavior passes a focused live probe, the original Session remains usable, and the listener PID is unchanged.
6. On syntax, activation, or render failure, inspect the exact Package or Loader diagnostics and repair the same Plugin. Dynamic updates roll back by running the previous current Package; repository HMR retains or restores the last loadable module on reload failure. A logical regression requires a precise inverse edit and another targeted build.

The repository route requires the active profile's HMR roots to include the target package's compiled `lib` directory. If the target is not watched, use a dynamic Package for the current-session prototype or report that one external cold start is needed to expand the watch roots. Never solve a missing watch root by killing the current host.

## Cold boundary

Treat changes to CLI/profile boot, Loader or HMR itself, process-wide web binding, or an incompatible persistence migration as cold-boundary changes. Finish the source change and validation, write a concise restart handoff, and leave the running service alone. A restart is a separate externally launched action, not a self-bootstrap tool call.

## Load only the applicable repository Skill

- Before choosing a non-obvious implementation, load `dsh-find-simplifications` when deletion, reuse, or a smaller existing seam may solve the problem.
- For code changes, load `dsh-code-review` after the focused tests and `dsh-pre-push-checks` before claiming the change is ready. Run the smallest checks that cover the diff.
- For prose or documentation, load `dsh-prose-standard`; also load `dsh-doc-standards` when placement, bilingual pairs, or documentation gates are involved, and `dsh-trim-cot-leakage` when the text contains session or review narration.
- Load `dsh-doc-site-sync` only when a website-visible document changes. Load `record-browser-gif` only for a product-visible GUI change that is being prepared as a pull request.
- Load `dsh-archive-agent-notes` only for actual Agent Note archival. Load `dsh-merging-stacked-prs` only for a real same-repository PR stack.
- `dsh-translate-docs` remains manual-only. Do not load it unless the user explicitly invokes that Skill by name; routine bilingual edits follow the repository's lightweight pairing rules.

## Evidence for a self-change

1. State the exact behavior being changed and the observable pass condition.
2. Inspect the owning plugin seam and current composition before editing.
3. Apply one bounded change. Do not expand the scientific goal into Harness work.
4. Run focused unit or composition tests, then the applicable repository Skill checks.
5. Report the source files, tests, live-runtime generation, Session continuity, listener PID before and after, and any behavior that still requires a host restart. Never infer success from a clean edit or a superficial passing check.

When deliberately testing a failure mode, use a synthetic session or fixture. Do not mutate or delete a user's real research Session as test data.
