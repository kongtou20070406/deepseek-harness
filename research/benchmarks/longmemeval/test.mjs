import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoLabelLeak,
  datasetProfile,
  selectorViewToPiMessages,
  splitLongMemEval,
  stratifiedSample,
} from "./adapter.mjs";
import { lexicographicDecision, pairedAccuracy } from "./statistics.mjs";

function fixture(index = 0, type = "single-session-user") {
  return {
    question_id: `secret_${index}`,
    question_type: type,
    question: `Question ${index}?`,
    answer: `Private answer ${index}`,
    question_date: "2026/01/01",
    haystack_dates: ["2025/01/01", "2025/01/02"],
    haystack_session_ids: [`noise_${index}`, `answer_${index}`],
    haystack_sessions: [
      [{ role: "user", content: "ordinary history", has_answer: false }],
      [{ role: "user", content: `the remembered fact is Private answer ${index}`, has_answer: true }],
    ],
    answer_session_ids: [`answer_${index}`],
  };
}

test("selector view strips every official answer label and blinds session ids", () => {
  const { publicCases, references } = splitLongMemEval([fixture()]);
  const item = publicCases[0];
  const reference = references.get(item.caseKey);
  assertNoLabelLeak(item.selectorView, reference);
  const serialized = JSON.stringify(item.selectorView);
  for (const forbidden of ["question_id", "answer_session_ids", "has_answer", "secret_0", "answer_0"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  // The factual answer text may legitimately occur in raw history; only its
  // scoring role and location labels are hidden.
  assert.match(serialized, /Private answer 0/);
  assert.throws(() => { item.selectorView.sessions.push({}); }, TypeError);
});

test("Pi message conversion contains only blinded session metadata and raw turns", () => {
  const { publicCases } = splitLongMemEval([fixture()]);
  const messages = selectorViewToPiMessages(publicCases[0].selectorView);
  assert.match(messages[0].content, /memory_session id=s_[a-f0-9]{16}/);
  assert.equal(messages.every((message) => /memory_session id=s_[a-f0-9]{16} date=/.test(message.content)), true);
  assert.equal(messages.some((message) => /has_answer|answer_0/.test(message.content)), false);
});

test("stratified sampling is deterministic", () => {
  const rows = Array.from({ length: 18 }, (_, index) => fixture(index, index % 2 ? "multi-session" : "temporal-reasoning"));
  const { publicCases } = splitLongMemEval(rows);
  const first = stratifiedSample(publicCases, 8).map((item) => item.caseKey);
  const second = stratifiedSample(publicCases, 8).map((item) => item.caseKey);
  assert.deepEqual(first, second);
  assert.equal(first.length, 8);
  assert.equal(datasetProfile(publicCases).likelyOracleOnly, true);
});

test("non-inferiority is paired and lexicographic comparison cannot skip accuracy", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    localCorrect: index < 90,
    lunaCorrect: index < 92,
  }));
  const paired = pairedAccuracy(rows, { bootstrapSamples: 4000, seed: 7 });
  assert.equal(paired.localNonInferior, true);
  assert.equal(paired.statisticallyEquivalent, false);
  const decision = lexicographicDecision({
    paired,
    local: { meanContextTokens: 1, assemblyMedianMs: 1, assemblyP95Ms: 1 },
    luna: { meanContextTokens: 1000, assemblyMedianMs: 1000, assemblyP95Ms: 1000 },
  });
  assert.equal(decision.criterion, "accuracy-inconclusive");
  assert.equal(decision.winner, null);
});

test("token and latency criteria unlock only after accuracy equivalence", () => {
  const rows = Array.from({ length: 100 }, () => ({ localCorrect: true, lunaCorrect: true }));
  const paired = pairedAccuracy(rows, { bootstrapSamples: 1000 });
  const token = lexicographicDecision({
    paired,
    local: { meanContextTokens: 50, assemblyMedianMs: 20, assemblyP95Ms: 30 },
    luna: { meanContextTokens: 60, assemblyMedianMs: 1, assemblyP95Ms: 2 },
  });
  assert.deepEqual(token, { winner: "local", criterion: "context-tokens" });
});

test("a tiny smoke sample can never establish equivalence or choose a winner", () => {
  const paired = pairedAccuracy([
    { localCorrect: true, lunaCorrect: true },
    { localCorrect: true, lunaCorrect: true },
  ], { bootstrapSamples: 100 });
  assert.equal(paired.inferenceReady, false);
  assert.equal(paired.localNonInferior, null);
  assert.equal(paired.statisticallyEquivalent, null);
  const decision = lexicographicDecision({
    paired,
    local: { meanContextTokens: 1, assemblyMedianMs: 1, assemblyP95Ms: 1 },
    luna: { meanContextTokens: 100, assemblyMedianMs: 100, assemblyP95Ms: 100 },
  });
  assert.deepEqual(decision, { winner: null, criterion: "accuracy-insufficient-sample" });
});
