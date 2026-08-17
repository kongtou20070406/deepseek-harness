# GaRAGe paired-context experiment protocol

This note audits the official GaRAGe paper and data release, then fixes the
minimum protocol for an internal paired comparison between Pi Idea's local and
Luna-enhanced context selectors. It is not an official leaderboard protocol.

Primary sources:

- Findings of ACL 2025 paper: <https://aclanthology.org/2025.findings-acl.875/>
- Official data repository: <https://github.com/amazon-science/GaRAGe>

## 1. What the official benchmark measures

The release contains 2,366 questions and 35,351 passages. Each passage has raw
text, a stable citation ID, provider, date and age. Gold annotations separately
mark topical relevance, grounding quality (`ANSWER-THE-QUESTION`,
`RELATED-INFORMATION`, `OUTDATED`, `UNKNOWN`), and whether the human answer
cited the passage.

The paper reports four families of outcome:

1. **Eligibility**: a judge compares the test answer with the human answer and
   returns `No Issues`, `Minor Issue(s)`, or `Major Issue(s)`. Eligibility is
   the percentage without a major issue. This is the paper's closest proxy for
   answer correctness/completeness; it is not exact-match accuracy.
2. **Factuality**: a judge splits the response into sentences and labels each
   `supported`, `unsupported`, `contradictory`, or `no_rad`. An answer is
   factual only when every sentence is supported or needs no factual
   attribution. `uRAF` repeats this judgment against only relevant grounding.
   `Factuality = Eligibility AND unadjusted factuality`; `RAF = Eligibility AND
   uRAF` at the example level, then averaged.
3. **Deflection**: a judge labels each response `missing` or `attempted`.
   Report true-positive deflection on the insufficient-grounding subset and
   false-positive deflection on the answerable remainder.
4. **Attribution**: compare citation IDs occurring in the model answer with
   citation IDs in the human answer and report precision, recall and F1. This
   part is deterministic once citation parsing and aggregation conventions are
   fixed.

The paper generated answers with the same prompt for every model, included the
question time, required use of search results only, required inline citations,
required a deflection when evidence was insufficient, and used greedy decoding.

## 2. What is and is not reproducible as an official score

The paper used `gpt-4o-2024-11-20` at temperature 0.2 as judge for the
model-judged metrics. The released repository contains data only; it does not
contain executable evaluation code. The prompts are printed in Appendix B.

Consequences:

- Eligibility, factuality, uRAF/RAF, and deflection depend on a proprietary
  judge. Replacing it with Luna changes the measurement instrument. The result
  must be named **Luna-judged internal paired score**, never an official
  GaRAGe score or leaderboard result.
- Attribution can be recomputed locally, but the paper does not publish enough
  code to disambiguate citation normalization, empty-set conventions, or
  micro-versus-macro aggregation. Report both per-case macro and corpus micro
  P/R/F1 and publish the parser.
- The text says uRAF uses "relevant" passages, but the data has both a broad
  `evidence_relevant` field and the finer grounding-quality/citation fields.
  Because no evaluator code is released, publish two explicitly named
  diagnostics instead of silently choosing one:
  - `topic_uRAF`: judge against `evidence_relevant == YES` passages;
  - `answer_uRAF`: judge against `ANSWER-THE-QUESTION` passages plus any
    passage cited by the validated human answer.
  The decision-oriented primary below uses `answer_uRAF`; neither value should
  be presented as an exact reproduction of the paper's RAF.

## 3. Official-data findings that affect the protocol

The local pinned file yields these post-hoc strata:

| Stratum | Rows |
| --- | ---: |
| Has at least one `ANSWER-THE-QUESTION` passage | 1,901 |
| Relevant-only (topically relevant, no answer-bearing passage) | 360 |
| Insufficient (no topically relevant passage) | 105 |
| Contains `OUTDATED` evidence | 606 |
| Time-sensitive | 1,586 |
| Multi-hop | 713 |

The paper's 427 expected-deflection rows cannot be reconstructed as merely
"no `ANSWER-THE-QUESTION` passage" (that would yield 465), nor as "no relevant
passage" (105). In the released file, the 427 rows are exactly the rows where:

```text
answer_validate == ""  AND  every evidence_cited value is "NO"
```

Those two predicates agree on all 2,366 rows. Of these 427 rows, 425 contain
the canonical deflection answer and two contain an empty human-answer field.
This derived flag is gold-side only.

## 4. Paired conditions and no-leak boundary

Compare exactly two conditions on every sampled case:

- **L — local**: the production deterministic local selector.
- **E — enhanced**: the production Luna-tag-enhanced selector after every
  passage index record is ready and its raw hash/provenance has been validated.

Both conditions must have the same candidate passages, hard evidence-token
ceiling, maximum selected passages, P0/instructions, answer model, reasoning
setting, output cap, and citation format. The only experimental factor is
selection/ranking. Preserve the original `cite_n` ID and exact raw passage text;
never renumber selected evidence.

The selector/tagger/generator may receive only:

```text
question, question_date,
passage text, citation ID, provider, source date, source age
```

All question annotations, evidence relevance/correctness/citation labels,
human answers, validation fields, comments and diagnostic strata remain in a
physically separate judge object. Luna-generated tags may rank candidates but
must never be injected as factual prose; the final answer model sees exact raw
evidence and provenance only. Tags are generated passage-by-passage without
the gold answer or post-hoc stratum.

This experiment evaluates the warm enhanced path. Separately test the cold
production invariant: pending/failed Luna indexing immediately uses L, without
waiting for a tag. Do not fold cold-index latency into warm assembly latency;
report both independently.

## 5. Generation and blind judging

For each case:

1. Compile L and E under the same budget and record selected citation IDs,
   exact serialized context tokens, assembly latency, and cache state.
2. Randomize AB/BA generation order with a fixed, published seed. Use isolated
   stateless Luna calls and the Appendix B.1 answer instructions. Include the
   official question time and require evidence-only answers, inline citations,
   and explicit deflection when information is insufficient.
3. Strip method names from outputs, assign random opaque IDs, and shuffle judge
   order independently of generation order.
4. Run the Appendix B.2 eligibility prompt separately for each output.
5. Run the Appendix B.3 factuality prompt separately for each output against:
   (a) its injected raw context, (b) the broad topic-relevant gold context, and
   (c) the decision-oriented answer-support context. Gold is introduced only
   here, after generation.
6. Run the Appendix B.4 deflection prompt separately for every output, so both
   true-positive and false-positive deflections are measurable.
7. Parse citations locally and compute both macro and micro attribution P/R/F1.
8. Rejudge a fixed 10% audit subsample once, with new opaque IDs, to report
   Luna judge self-consistency. Never choose the more favorable repeat.

Do not combine both conditions in one comparative judge prompt: that introduces
position and pairwise-preference effects absent from the official protocol.

## 6. Primary and diagnostic outcomes

The primary binary outcome is **Decision Success**:

```text
if expected_deflection:
    deflection_judge == "missing"
else:
    eligibility != "Major Issue(s)" AND answer_uRAF == true
```

This keeps the user-facing objective at the final answer/decision, rather than
optimizing retrieval labels. Report these diagnostics but never use them to
override a worse Decision Success result:

- eligibility, injected-context factuality, `topic_uRAF`, `answer_uRAF`;
- deflection TPR and FPR;
- citation macro/micro P/R/F1;
- answer-bearing passage recall and precision;
- selected-token share from `RELATED-INFORMATION`, `OUTDATED`, `UNKNOWN`, and
  irrelevant passages;
- injected tokens, warm assembly median/P95, cold indexing calls/tokens/time,
  and tag-cache failure rate.

## 7. Sampling

Use a SHA-256-derived deterministic sampler over stable sample IDs. The five
mutually exclusive diagnostic strata, in priority order, are:

1. insufficient: no topically relevant passage;
2. relevant-only: relevant evidence but no `ANSWER-THE-QUESTION` passage;
3. answerable multi-hop;
4. answerable temporal: contains outdated evidence or is time-sensitive, but
   is not multi-hop;
5. ordinary answerable: the remainder.

### Pilot

Use **n = 80**, 16 per stratum. Within the temporal stratum require at least
eight cases containing `OUTDATED` evidence; within the first two strata ensure
the official expected-deflection flag is represented. The pilot is a pipeline
and gross-effect gate, not a confirmatory significance test.

Stop before the formal run if any of these occurs:

- gold field appears in selector, tagger, or generator payload;
- original citation identity or raw passage hash is lost;
- judge JSON parse failure exceeds 2%;
- E uses a different evidence ceiling or answer configuration;
- E Decision Success is more than 10 percentage points below L in the pilot;
- total Luna ledger projection would cross the global 100M-token cap.

### Formal run

Start at **n = 500**, 100 per stratum. Compute both the equal-stratum macro
result and a result reweighted to the official five-stratum prevalence. Use a
paired, stratified case bootstrap with at least 10,000 deterministic replicates.
If the effect is too close to zero to resolve, extend once to n = 1,000 using
new sample IDs; do not repeatedly peek and extend without a predeclared rule.

Promotion gates, in order:

1. **Fallback non-inferiority**: the one-sided 95% lower confidence bound of
   `DecisionSuccess(L) - DecisionSuccess(E)` must be greater than -0.10.
2. **Enhanced superiority**: claim E superior only if the two-sided 95%
   confidence interval of `DecisionSuccess(E) - DecisionSuccess(L)` is wholly
   above zero. Also veto promotion if any stratum has an observed drop greater
   than 10 points or a Holm-adjusted significant negative effect.
3. **Correctness equivalence for tie-breaking**: only when the 90% confidence
   interval is fully inside a predeclared +/-5-point equivalence band may lower
   injected tokens decide; only after correctness and tokens are tied may warm
   median/P95 assembly latency decide.

The 10-point non-inferiority margin is the existing product requirement. The
5-point band is deliberately stricter: passing the safety floor is not the same
as proving that two methods are close enough to choose solely on token cost.

## 8. Luna call and token budget

Under production-faithful indexing, GaRAGe has 5--15 passages per case (mean
14.94; median and P95 both 15). A first warm E evaluation therefore uses:

| Work | Luna calls per case |
| --- | ---: |
| Passage tag creation | 5--15 (mean 14.94), once per cold case |
| Answer generation (L and E) | 2 |
| Eligibility judges | 2 |
| Factuality judges | 2 |
| Deflection judges | 2 |
| Attribution | 0 (local) |
| **Total first pass** | **13--23 (mean 22.94)** |

The official file has mean grounding length 8,462 characters (P95 13,115),
and mean human-answer length 1,096 characters. With a 1.5--2K-token selected
context ceiling and compact judge outputs, budget approximately **20K--35K
total Luna tokens per case**, including cold passage tagging. That implies
roughly **1.6M--2.8M** tokens for the n=80 pilot and **10M--17.5M** for n=500.
These are planning bounds, not measured usage; the runner must charge actual
input, cached-input, reasoning and output usage to the existing global ledger
and stop before 100M total.

Warm repeat loops reuse validated tags, so separately report the much smaller
per-loop cost (two generations plus judges for this benchmark) and the local
assembly latency. Never hide cold indexing cost inside amortized averages.
