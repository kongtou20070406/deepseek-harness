# Pi-Idea v6.4 — Handoff Snapshot

Generated: 2026-08-14 (Asia/Shanghai)
Status: `production adopted / tests green / artifact sealed`

## Confirmed objective

Build a Sol-centered Pi research partner that can work for weeks without carrying the whole conversation: preserve the user's real research intent and traceable evidence outside the model, compile only the current task's needed context, and delegate bounded mechanical work without contaminating the main research loop.

Priority is lexicographic: task success, authority correctness, input tokens, CPU latency. Raw history is permanent unless the user explicitly requests cleanup. 60% of the model window is a soft line; 85% is the complete-input hard line.

## Delivered architecture

- append-only raw Pi session ledger;
- user-confirmed Idea/stage/narrow trusted state;
- rebuildable project SQLite/FTS locator index;
- per-loop `dialogue` and `tool-evidence` islands;
- v6.4 proof-carrying evidence ladder with active-domain routing, authority spine, exact dependency closure and gap escalation;
- exact continuation frame for bare “继续”;
- model-free, asynchronous single-worker blockization/indexing;
- Obelisk explicit-gap compatibility only;
- production default evidence assembly; explicit `PI_IDEA_CONTEXT_MODE=safe` rollback;
- partially localized research console and Workflow visibility.

## Adoption evidence

Luna v2 unseen long-horizon gate: task rolling `50.00%` vs candidate `87.50%`, raw `68.75%`; authority rolling `62.50%` vs candidate `93.75%`, raw `87.50%`; compression `90.91%`; all gates passed.

Fixed 5% Sol/max v2, 78 new targets:

- task `85.90% -> 94.87%`, paired CI `[+2.56,+16.67]pp`, 8:1;
- authority `85.90% -> 96.15%`, CI `[+2.56,+17.95]pp`, 9:1;
- mean context `19,232.38 -> 1,518.64`, compression `92.10%`;
- candidate assembly P95 `3.89 ms`;
- 312 calls, 2,970,694 tokens, 0 failures; formal gate passed.

Local verification: extension `89/89`, research protocols `58/58`, installed Pi smoke passed. 5k-block CPU benchmark: ordinary loop P95 `0.857 ms`, continuation P95 `1.260 ms`.

## Start and rollback

```powershell
.\start-pi.ps1 -Thinking max
```

```powershell
$env:PI_IDEA_CONTEXT_MODE='safe'
.\start-pi.ps1 -Thinking max
```

## Authoritative handoff files

- `research/FINAL_CONTEXT_ASSEMBLY_SCHEME_V3_2026-08-14.md`
- `research/PI_IDEA_CONTEXT_MODULE_DELIVERY_V6_4_2026-08-14.md`
- `pi-idea-extension/README.md`
- `research/benchmarks/bidirectional-context/results/long-horizon-luna-gate-v2-manifest.json`
- `research/benchmarks/bidirectional-context/results/long-horizon-luna-gate-2026-08-13T19-32-59-784Z-8f30f13c.json`
- `research/benchmarks/bidirectional-context/results/long-horizon-sol-5pct-v2-manifest.json`
- `research/benchmarks/bidirectional-context/results/long-horizon-sol-5pct-e963f5d3d880-result.json`

## Honest limits

The long-horizon fixture combines real MemSyco histories into a synthetic multi-project stream; rolling-extractive is not the proprietary Codex compactor; Sol self-judging is not human blind review. The benchmark supports production adoption under this frozen contract, not a claim that every natural multi-week EqOp research trajectory is solved.

After the formal gate, only deterministic production-adapter protections were added: the externally retained live tail is not duplicated as a cold tail, and exact/continuation roots are mandatory closures. They are locally tested and preserve the benchmark compiler's default behavior; no third formal model run was performed.

## Next product work

The context-assembly module is delivered. The next useful direction is UI/interaction: polish the Claude-Code-like terminal research console, expose per-loop evidence reasons and safe rollback clearly, then validate the two-layer Sol/Workflow experience in natural multi-week EqOp use. Do not restart selector benchmarking unless a concrete production regression creates a new falsifiable hypothesis.
