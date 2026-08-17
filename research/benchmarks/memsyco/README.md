# MemSyco-Bench judgment adapter

This directory contains an isolated adapter and paired-evaluation protocol for
MemSyco-Bench. It does **not** contain a benchmark score and does **not** turn
the included synthetic fixtures into benchmark data.

## Verified official release

Primary sources:

- Paper (arXiv v2, 2026-07-02): <https://arxiv.org/html/2607.01071>
- Official repository: <https://github.com/XMUDeepLIT/MemSyco-Bench>
- Official data schema: <https://raw.githubusercontent.com/XMUDeepLIT/MemSyco-Bench/main/data/schema.json>
- Official manifest: <https://raw.githubusercontent.com/XMUDeepLIT/MemSyco-Bench/main/data/manifest.json>
- Hugging Face dataset: <https://huggingface.co/datasets/MemSyco-Bench/MemSyco-Bench>

The current release is schema `1.2`, with 1,550 rows and seven top-level
fields: `id`, `task`, `dialogue`, `question`, `memory`, `evaluation`, and
`metadata`.

| Task | Policy | Rows | What decision authority means |
|---|---:|---:|---|
| Objective Fact Judgment | `ignore_as_evidence` | 300 | A remembered preference is framing, not factual evidence. |
| Contextual Scope Control | `constrain_to_scope` | 300 | Preserve useful preference content without transferring it beyond its subject, audience, or constraints. |
| Memory-Evidence Conflict | `defer_to_evidence` | 300 | Decisive current evidence outranks a conflicting historical preference. |
| Valid Memory Selection | `update` | 350 | Use the current preference and suppress the outdated one. |
| Personalized Memory Use | `use` | 300 | Apply the active preference when personalization is required. |

The pinned counts, policies, filenames, and official SHA-256 values are stored
in `OFFICIAL_MANIFEST_V1_2` in `adapter.mjs`. The loader validates every row,
count, task-policy pair, and file checksum before returning cases. The HF
manifest hashes canonical CRLF bytes, while four downloaded JSONL files use LF
and one uses CRLF. The loader therefore records both the raw SHA-256 and a
canonical-CRLF SHA-256. A transport passes only when its raw or canonical hash
matches the manifest, and pinned runs additionally require the canonical hash
to equal the known release hash. Newline normalization cannot hide content
changes.

## Gold-isolation boundary

The official data card says `memory` and `evaluation` are gold annotations and
must not be exposed to the answer model outside an explicit oracle condition.
This adapter also withholds `metadata`, the task name, and the task-coded
official ID from online selection. The selector receives only:

```text
opaque case key
raw dialogue role/content
current question
deterministic per-turn provenance IDs (sidecar only)
```

The official schema contains no timestamps. This adapter never invents dates.
It preserves source identity through sidecar turn IDs and keeps the original
role/content unchanged in the Pi messages.

`sealMemSycoOnlineResult()` freezes the answer, neutral evidence view, token
count, and assembly time before `makeMemSycoPostHocPacket()` is allowed to join
them with reference annotations. This makes leakage a testable phase boundary
rather than a prompt convention.

The evidence view has one schema for both experimental paths:

```text
cold: exact raw quote selected from a cold unit
active: exact raw role/content retained as live context
provenance: opaque turn ID, history index, role, real timestamp or null,
            and cold source-unit ID or null
```

It intentionally excludes compiler wrappers, derived claim text, scores,
selector names, and path names. MemSyco v1.2 contains no timestamps, so these
rows carry `timestamp: null`; the adapter never invents chronology.

## Diagnostic protocol

The paper distinguishes retrieval failure (`R-/A-`) from post-retrieval
decision failure (`R+/A-`). This protocol adds explicit authority use and emits
the following mutually exclusive row-level outcomes:

- `retrieval-missing`: task-required decision evidence was absent and the answer failed.
- `retrieved-but-wrong`: required evidence was present, but the answer or authority decision failed.
- `correct-authority-use`: the answer was correct and memory received the correct decision authority.
- residual diagnostics for correct guesses without required evidence, factual errors where retrieval is not required, judge disagreement, and unscorable output.

Retrieval sufficiency must be judged post-hoc from the **neutral evidence
view**, not inferred from embedding score or token overlap. The view includes
both exact selected cold quotes and exact active live messages, because a
decision can be sufficiently grounded by either. Task-specific guidance is
returned by `retrievalJudgeInstruction()`:

- scope cases require both the usable preference and its boundary;
- conflict cases require decisive evidence, not merely the preference;
- update cases require the current preference plus ordering/update evidence;
- personalization cases require the active preference;
- objective-fact cases do not require historical context for the fact, and a
  misleading preference must never be labeled supporting evidence.

## Paired local/Luna comparison

Every included case must have exactly one `local` and one `luna` result.
`summarizeMemSycoPaired()` reports:

- primary task success, defined as **answer correct AND authority use correct**;
- answer-only accuracy and correct-authority-use rate as diagnostics;
- the diagnostic split above, globally and by task;
- injected context tokens (mean/median/P95);
- local assembly latency (mean/median/P95);
- paired local-minus-Luna task success with a deterministic bootstrap interval;
- a separate answer-only paired interval, so a correct answer reached through
  the wrong authority does not masquerade as harness success;
- the formal 10-percentage-point local non-inferiority gate only when the
  configured minimum paired sample size is reached.

Use the same cases, answer model, judge model, answer prompt, decoding settings,
and context budget for both conditions. Only the assembler/index path may
differ. Task success remains the primary decision criterion; compare tokens
only after task success is acceptable, then compare assembly P50/P95.

Internal Luna-model runs are paired product experiments, not automatically
comparable to the official leaderboard's generator/judge configuration.

## Reproducible paired runner

`run.mjs` compares the current deterministic local raw-passage path with the
current Luna-tag-enhanced fusion path. Both conditions use the same Luna answer
model, answer prompt, judge model, context budget, and decoding settings. The
common answer prompt contains the same authority/recency/scope instruction in
both lanes, so this measures the **context assembly difference**, not an
unprompted base model.

The compiler receives history only; the current question is used as its query
and is inserted exactly once in the answer prompt. Defaults (`fold-min=1`,
`live-turns=1`) are intentionally lower than production's large-block default,
because released MemSyco histories are only about 0.9k–2.9k estimated tokens.
Every case must produce at least one stable cold unit. The paid run also stops
if local and Luna serialize to identical contexts.

The answer order is deterministically balanced by `seed + opaque case key`.
Judge order is the reverse. Each complete local/Luna answer pair is atomically
written under `results/<run>-frozen-online/` before any post-hoc prompt can join
it with `memory`, `evaluation`, task, metadata, or official ID.

Judge blinding is schema `memsyco-judge-blind-v2`. Each case and seed creates
two opaque lane tokens from a neutral ordinal; the token is never derived from
the condition name. The judge callback, prompt, cache filename, and ledger call
receive only that token. They do not receive `local`, `luna`, the compiler
track, or the sealed condition object. Only the orchestration layer maps a
completed judge response back to its condition. The prompt carries exact raw
evidence and provenance through the neutral view, but it does not carry
`<local_evidence_index>`, `<assembled_evidence>`, derived claims, or selector
algorithm names.

This replaces the earlier sidecar that stored the whole serialized answer
context as one `selectedEvidence[0].content` blob. That blob was exact, but it
mixed selected cold evidence with active messages and exposed condition-specific
compiler wrappers. It therefore let a judge infer the path and made retrieval
sufficiency ambiguous. V2 separates the two evidence kinds without changing
their raw text.

## Migration from the unblinded pilot

No model call was made while implementing this migration.

- Existing `answer-local-*` and `answer-luna-*` cache payloads remain reusable:
  the online answer prompt and frozen answer text are unchanged.
- Rebuilding a frozen pair from those answer caches creates schema-2 sealed
  rows with a neutral `evidenceView`; its online digest changes because the
  evidence sidecar is now correctly structured, not because the answer changed.
- Existing `judge-local-*` and `judge-luna-*` outputs were produced from an
  unblinded prompt. Keep them only as audit artifacts; do not merge their scores
  with V2 results and do not rename them into the new cache.
- V2 judge caches use `judge-v2-<opaque-lane>-<prompt-hash>.json`. A future
  scored run must rejudge the frozen answers under V2; this repository change
  deliberately does not spend tokens to do that.

No Sol model is accepted: `answer-model`, `judge-model`, and `tag-model` all
fail closed unless they are `gpt-5.6-luna`. In addition to the shared 100M Luna
ledger, `--max-luna-tokens` places a conservative per-run ceiling in front of
the shared reservation. `--dry-run` makes zero model calls.

```powershell
# Official-data integrity + non-degenerate assembly plumbing; zero Luna calls
& '.tools\node-v24.18.0\node-v24.18.0-win-x64\node.exe' `
  'research\benchmarks\memsyco\run.mjs' `
  --dry-run --per-task=2 --seed=memsyco-paired-pilot-v1

# Small paid pilot (10 cases, 2 per task); review dry-run first
& '.tools\node-v24.18.0\node-v24.18.0-win-x64\node.exe' `
  'research\benchmarks\memsyco\run.mjs' `
  --per-task=2 --seed=memsyco-paired-pilot-v1 `
  --max-luna-tokens=10000000
```

The pilot cannot pass the formal 10-point non-inferiority gate: inference is
deliberately withheld below 60 paired cases. It is for plumbing and signal
checks before a larger authorized run. Result JSON records the sample seed,
dataset digest, condition/judge order, frozen online digests, task-success and
answer-only intervals, exact serialized-context token estimates, assembly
P50/P95, and both run-local and aggregate Luna budgets.

## Running the protocol tests

```powershell
& '.tools\node-v24.18.0\node-v24.18.0-win-x64\node.exe' `
  --test 'research\benchmarks\memsyco\*.test.mjs'
```

The fixtures in `fixtures.mjs` are deliberately marked
`SYNTHETIC_SCHEMA_FIXTURES_NOT_OFFICIAL_BENCHMARK_DATA`. They test all five
schemas, leak prevention, checksum enforcement, diagnostic attribution, paired
statistics, tokens, and P95 without making API calls.

## Official data on this machine

The official 1,550-row release is available read-only at
`research/benchmarks/third_party/memsyco/`. The real-data test loads all five
files, verifies pinned schema/count/policy/content identity, and runs the online
gold-leak assertion over every case. This adapter still claims no formal score:
no answer model or judge was called by these tests.
