# GaRAGe official-data adapter

This directory contains a dependency-light, offline adapter for the official
GaRAGe release. It does not call a model and it does not modify the Pi
production path.

GaRAGe (*A Benchmark with Grounding Annotations for RAG Evaluation*) was
published in **Findings of ACL 2025**. The upstream dataset contains 2,366
questions and 35,351 annotated passages from Web and private-enterprise
sources. The bundled upstream material is licensed **CC-BY-NC-4.0**; in
particular, its non-commercial restriction still applies to the copied data.

- Paper: <https://aclanthology.org/2025.findings-acl.875/>
- Upstream repository: <https://github.com/amazon-science/GaRAGe>
- Local upstream copy: `../third_party/garage/`

## Pinned release

`loadGarageBench()` only accepts the exact local official release:

| Property | Expected value |
| --- | --- |
| File | `data/GaRAGe_benchmark.jsonl` |
| Bytes | `28,426,483` |
| SHA-256 | `419e3941f6e8eb4082a74ca2140c1f9337f8b467ff76656a6b8b0290ca3f3a72` |
| Questions | `2,366` |
| Grounding passages | `35,351` |

The loader verifies the byte length and SHA-256 before parsing, rejects any
top-level or passage field outside the official schema, checks every aligned
annotation array, rejects duplicate IDs, and verifies final row/passage counts.

## Hard online / judge boundary

`splitGarageRow()` creates two physically separate objects:

- `selectorView` is the only object allowed into online context selection. It
  contains the question, question date, and grounding passages. Every passage
  keeps its own exact text plus provider, source date, source age, citation ID,
  citation ordinal, and question date. Unknown dates and relative ages are
  preserved verbatim rather than guessed or normalized.
- `reference` contains the official sample ID, evidence relevance/correctness/
  citation judgments, human answer, validation/comments, question metadata,
  and post-hoc eligibility labels.

The online object has a closed schema and a recursive forbidden-key guard.
`question_sensitive`, `question_type`, `question_complexity`, category,
popularity, and tags remain post-hoc annotations. They are **not** treated as
production-observable routing hints.

## Reported strata

The loader returns exact histograms for providers; question complexity, raw
domain strings, popularity, change type, question/topic tags; evidence labels;
and these post-hoc eligibility labels:

- `answerable-grounding`, `relevant-only-grounding`, or
  `insufficient-grounding` (mutually exclusive);
- `answer-validated` or `answer-unvalidated`;
- `time-sensitive` or `not-time-sensitive`;
- `contains-outdated` or `no-outdated`;
- `mixed-provider` or `single-provider`.

These labels exist for evaluation stratification only and never enter the
selector view.

## Evidence-selection A/B diagnostic

`run-selection.mjs` compares two frozen, model-free conditions:

- **A (`A-production-local`)** invokes the real current
  `compileContext({ localEvidenceIndex: true })` path. The adapter serializes
  each grounding passage with exact citation and time/source provenance, then
  maps the compiler's selected raw clauses back to official passage IDs.
- **B (`B-judgment-set`)** is benchmark-local and is not wired into Pi. It
  greedily optimizes an evidence *set*: uncovered question aspects, temporal
  consistency, non-duplicate incremental information, explicit conflict
  retention, and an online sufficiency decision. `web` versus `ent` is only a
  tiny diversity bit, never an authority or scientific-credibility score.

Both selectors receive only the closed `selectorView`. Official relevance,
correctness, citation and answer fields are joined after selection. Tests also
verify that rewriting every gold label leaves B unchanged and that nested gold
fields cause both selectors to fail closed.

The post-hoc report includes per-class selection precision/recall/token share
for `ANSWER-THE-QUESTION`, `RELATED-INFORMATION`, `OUTDATED`, `UNKNOWN`, and
unlabelled passages; answer-evidence availability; deflection readiness;
selected tokens; and assembly P95. These are **selection diagnostics only**.
They are not answer accuracy or task success. The result schema keeps all task
success fields `null` until the same answer model and an official-compatible
judge are run over both frozen contexts.

The first 240-case seed (`garage-selection-v1`) was used as an exploratory
development diagnostic. The saved holdout excludes those exact case keys:

`results/garage-selection-holdout-v1.json`

On that zero-overlap, stratified 240-case holdout, B retained at least one
answer-bearing passage on 89.92% of answerable cases versus 96.64% for A
(-6.72 percentage points), while reducing mean selected context from 1,113.35
to 943.95 estimated tokens (-15.22%) and measured assembly P95 from 1.57 ms to
0.74 ms in that run. Answer-bearing selection precision rose from 24.49% to
26.43%, while outdated selected-token share fell from 7.42% to 6.48%.
Deflection readiness remained only 1.65%; therefore the deterministic selector
alone does not solve the final judgment problem, and B must not enter
production based on this result.

Reproduce without writing a file or making any model call:

```powershell
node research/benchmarks/garage/run-selection.mjs `
  --sample 240 `
  --seed garage-selection-holdout-v1 `
  --exclude-seed garage-selection-v1 `
  --exclude-sample 240 `
  --dry-run
```

`--sample all`, fixed `--seed`, `--budget-tokens`, `--max-passages`, and
`--output` are also supported. `--dry-run` still performs the offline
diagnostic but never writes the requested output. This runner always makes
zero model calls.

## Tests

From the repository root:

```powershell
node --test research/benchmarks/garage/adapter.test.mjs research/benchmarks/garage/selector.test.mjs
```

The tests load and validate all 2,366 official rows, enforce the pinned file
fingerprint, run the recursive no-leak guard over every online view, check
official statistics, and exercise schema/fingerprint failure cases.
