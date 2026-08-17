# LSC-EPC Context Compiler Benchmarks

This directory contains the deterministic compiler shared with the Pi-Idea
production context path. It is model-free: typed raw blocks, structural DROP
certificates, KEEP precedence, dependency closure, current/historical recall,
context-validity ranking, marginal-coverage stop, and verbatim evidence output.

The raw Pi sessions remain the ledger. A compiler Manifest records retained,
dropped, and deferred blocks; `UNKNOWN` never means deleted or irrelevant.
Benchmark adapters may use synthetic entry coordinates, while production uses
real Pi `SessionEntry` and event-time Idea/stage/session coordinates.

## CPU-only checks

```powershell
node --test --test-concurrency=1 research/benchmarks/bidirectional-context/*.test.mjs

node research/benchmarks/bidirectional-context/run-memsyco-ablation.mjs `
  --sample-percent=5 `
  --budgets=8192 `
  --output=research/benchmarks/bidirectional-context/results/memsyco-lsc-epc-5pct-cpu-20260813.json
```

The assembly-only pilot never calls a model and cannot establish task success.

## Product gate: Sol raw vs LSC-EPC

The historical five-condition Luna runner is an internal ablation. It cannot
establish performance for the Sol-centered product. The product gate compares
only `full/raw` and the exact production `bidirectional-heat` LSC-EPC condition
on one immutable 5%/78-case manifest:

```powershell
# Zero calls: official bytes, exact cases, assembly hashes, and contracts.
node research/benchmarks/bidirectional-context/run-sol-paired-gate.mjs --validate-only

# Zero calls: print the complete authorization and cost contract.
node research/benchmarks/bidirectional-context/run-sol-paired-gate.mjs --dry-run
```

Dry-run also writes the inspected contract to
`results/sol-lsc-epc-5pct-preflight-20260813.json`.

The runner defaults to Sol/max for both answer and blind post-hoc judge. It
disables tools, extensions, skills, and context files; resets an ephemeral
session per call; and executes strictly serially. All online answers are
durably frozen before the judge phase opens gold fields. Identical answer
prompts reuse one completion, and identical frozen answer/evidence outcomes are
judged once.

It fails closed unless `--authorized-model-run` is present. The flag is only an
execution mechanism: explicit user approval of the printed dry-run contract is
still required. Current defaults are:

- exact fixed sample: 78 cases, never auto-expanded;
- primary gate: paired task-success non-inferiority;
- co-primary safety gate: correct authority-use non-inferiority;
- margin: 5 percentage points, 95% paired bootstrap, minimum 60 cases;
- observed-token hard stop: 8,000,000;
- normal call upper bound: 286; hard stop: 416;
- one bounded answer retry; no automatic judge retry;
- CPU-only local orchestration and no GPU requirement.

Pi 0.84.1 exposes no per-call max-output flag. The runner therefore reserves
the full 128k catalog output capability before every request, applies
post-response character caps, conservatively charges failed requests with no
usage, and stops before its token or call ledger can be crossed. Token savings
are ineligible for an adoption claim unless both performance gates pass.
