# Local reranker benchmark

Isolated experiment only. Nothing in this directory is loaded by the Pi Idea
extension. A model may enter production only after paired task-success and
latency evaluation.

Hard gates:

- local block ready P95 < 1,000 ms;
- per-loop lookup + assembly P95 < 2,000 ms;
- no task-success regression;
- deterministic local fallback when the model is absent or times out.

Candidate order:

1. Jina multilingual reranker v2 INT8 (278M, research-only CC-BY-NC-4.0);
2. GTE multilingual reranker base INT8 (306M, Apache-2.0);
3. mMARCO multilingual MiniLM INT8 (118M, Apache-2.0) as the speed floor.

The first two are deliberately below 0.5B parameters. We do not fine-tune by
default. Fine-tuning is considered only after a frozen-model error analysis
shows a repeatable domain gap that retrieval cues cannot fix.
