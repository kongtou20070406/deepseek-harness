# CAME-Bench Adapter

The adapter keeps the benchmark's answer, answer-turn IDs, partitions and action labels outside the context assembler. Only raw turn text, actor, per-turn time provenance, question text/date/type and ordinary turn IDs are visible online.

Expected official decoded layout:

```text
decoded_benchmark_codec/
  benchmark_meta.json
  traj-0/{turns.jsonl,questions.jsonl}
  ...
```

The official dataset is encoded to reduce contamination. Download it from <https://huggingface.co/datasets/Seattleyrz/CAME-Bench>, decode with the authors' `codec.py`, retain their SHA256 verification, and pass the decoded root to `loadDecodedCameBench()`.

Use the official 4,096-token retrieval-context cap for every condition. The project's Luna-only generation/judging configuration is for paired internal comparison and is not directly comparable to the paper's gpt-5-mini/gpt-4.1-mini leaderboard configuration.

Do not use `partition`, `action`, `action_object`, `answer_turn_ids` or the gold answer for query tags, retrieval or answer generation. They are evaluation-only labels.

Current state: the official encoded release has been downloaded, decoded with the authors' codec in strict mode, and accepted only after every decoded file passed its published size and SHA256 checks. The no-leak adapter loads 14 trajectories and 373 questions with dataset digest `sha256:a965affaf69664332d40d0d1f93c0149e8485e26303f48a05a5d3517c1d81036`. No formal CAME-Bench score is claimed until a paired run completes under the protocol above.
