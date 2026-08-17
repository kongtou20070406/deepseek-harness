# MemoryArena adapter and paired evaluation protocol

This directory provides a strict adapter/protocol skeleton for evaluating the
Pi Idea context assembler on
[MemoryArena](https://memoryarena.github.io/). It is intentionally not a second
implementation of the official environments.

## What is verified now

- The official Hugging Face test data is loaded from a content-addressed local
  snapshot and validated row by row.
- Each benchmark row is split into:
  - an immutable **online case** that the task agent/executor may see; and
  - a **judge-only reference** containing `answers` and evaluator metadata.
- Every session has row, source, field-path, and sequence provenance. Runtime
  actions and environment feedback have case/session/step/event provenance.
- Paired `local` and `luna` runs emit Task Success, Task Progress, token counts,
  assembly P50/P95/max, fallback rates, and strict local-vs-Luna deltas.
- A requested Luna run may immediately fall back to local, but only with
  `fallbackWaitMs: 0`. Such cases are reported under the requested condition and
  excluded from the strict local-vs-actual-Luna comparison.

## What is **not** verified by the adapter

Offline schema/integrity validation is not an official MemoryArena score. An
official Task Success/Progress result additionally requires the official
interactive environment and evaluator at pinned source revisions. The harness
will label a run `official` only when the dataset snapshot is verified and both
official code revisions are attested; it does not itself prove that those
services were set up correctly. Keep environment logs and evaluator artifacts
with every formal result.

The official paper defines:

- `Progress(task) = passed subtasks / all subtasks`, averaged across tasks.
- Shopping and travel Task Success require the complete bundle/plan to pass.
- Progressive search and formal reasoning Task Success use the correctness of
  the final dependency subtask.
- Travel may additionally report soft progress as the mean fraction of
  constraints satisfied.

The current public snapshot contains 701 rows, while the paper's February 2026
statistics report a different total. Therefore every result must record the
file hashes below rather than identifying the dataset only as `main`.

## Pinned public dataset snapshot (downloaded 2026-08-13)

| Config | Rows | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `bundled_shopping` | 150 | 1,601,723 | `4411a2da528a33dc6aca519b49cc225895363f18b2d19b191fddb501200134ef` |
| `progressive_search` | 221 | 3,618,343 | `b445ee36fa3ccb9ad08eae9e7adda86bbc64f14f1e2a0682a8b2085cdb8e4c0e` |
| `group_travel_planner` | 270 | 6,165,901 | `2f955d444f6f3ad3c5da2064359ab19f8fc1f90621ff9d00723a450a009c3732` |
| `formal_reasoning_math` | 40 | 829,228 | `ff5b0ad575847c7476a02d1e35661592a833bd0cff384cb54bc6f35b46de7803` |
| `formal_reasoning_phys` | 20 | 87,070 | `580862006af2ff2bfc8c5d2d2b9a60bf33a46cbb64f27d60a2bfe039aec61cf6` |

## Files

- `adapter.mjs`: strict schema, public/private split, provenance, leak guard.
- `loader.mjs`: JSONL loader and content-addressed snapshot verification.
- `protocol.mjs`: local/Luna condition and action/feedback trace contract.
- `metrics.mjs`: official domain-level success semantics and aggregate metrics.
- `harness.mjs`: paired executor/judge boundary; no environment implementation.

## Run tests

From the repository root, using the bundled Node runtime:

```powershell
& '.tools/node-v24.18.0/node-v24.18.0-win-x64/node.exe' --test research/benchmarks/memoryarena/*.test.mjs
```

The real-data test must validate all 701 rows. Fixture protocol tests exercise
the gold-isolation boundary and reporting only; their scores must never be
presented as formal MemoryArena results.

## Sources

- Paper: <https://arxiv.org/abs/2602.16313>
- Project: <https://memoryarena.github.io/>
- Data: <https://huggingface.co/datasets/ZexueHe/memoryarena>
- Official preview code: <https://github.com/ZexueHe/MemoryArena>
