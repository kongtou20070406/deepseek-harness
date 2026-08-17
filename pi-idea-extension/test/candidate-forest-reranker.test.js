import assert from "node:assert/strict";
import test from "node:test";
import { createCandidateForestReranker } from "../src/candidate-forest-reranker.js";
import { compileBidirectionalContext } from "../src/evidence-context-compiler.js";

test("candidate forest performs bounded numeric CPU inference", () => {
  const forest = createCandidateForestReranker({
    schema: 1,
    modelId: "fixture-forest",
    trees: [{ nodes: [
      { feature: "recency", threshold: 0.5, left: 1, right: 2 },
      { value: -1 },
      { value: 1 },
    ] }],
  });
  assert.ok(forest.score({ recency: 0.9 }) > 0);
  assert.ok(forest.score({ recency: 0.1 }) < 0);
  assert.throws(() => createCandidateForestReranker({ schema: 1, trees: [{ nodes: [{ feature: "rawText", threshold: 0, left: 0, right: 0 }] }] }), /Unsupported forest feature/);
});

test("forest score only reorders soft candidates and cannot suppress authority closure", () => {
  const forest = createCandidateForestReranker({
    schema: 1,
    modelId: "anti-authority-fixture",
    trees: [{ nodes: [
      { feature: "authorityUpdate", threshold: 0.5, left: 1, right: 2 },
      { value: 1 },
      { value: -1 },
    ] }],
  });
  const result = compileBidirectionalContext({
    messages: [
      { role: "user", id: "old", content: "I liked detailed book reviews." },
      { role: "assistant", id: "old-a", content: "Noted." },
      { role: "user", id: "new", content: "I no longer want detailed reviews; I prefer quick star ratings for books." },
      { role: "assistant", id: "new-a", content: "Understood." },
      { role: "user", id: "tail", content: "I found another book." },
    ],
    query: "How should I rate books?",
    condition: "bidirectional-heat",
    budget: 900,
    liveBlocks: 1,
    candidateReranker: forest,
  });
  assert.match(result.context, /no longer want detailed reviews/);
  assert.equal(result.manifest.reranker.modelId, "anti-authority-fixture");
  assert.ok(result.manifest.reranker.candidatesScored > 0);
  assert.equal(result.manifest.reranker.failures, 0);
});
