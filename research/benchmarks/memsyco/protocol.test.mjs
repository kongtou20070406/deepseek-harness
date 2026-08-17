import test from "node:test";
import assert from "node:assert/strict";
import { splitMemSycoRow } from "./adapter.mjs";
import { MEMSYCO_SCHEMA_FIXTURES } from "./fixtures.mjs";
import {
  assertMemSycoJudgePacketBlind,
  classifyMemSycoDiagnostic,
  makeMemSycoJudgeLaneToken,
  makeMemSycoPostHocPacket,
  makeMemSycoScoredResult,
  normalizeMemSycoJudge,
  sealMemSycoOnlineResult,
  summarizeMemSycoPaired,
} from "./protocol.mjs";

function evidence(turn, historyIndex = 0, { kind = "cold", verbatim = turn.content } = {}) {
  return {
    kind,
    provenance: {
      turnId: turn.turnId,
      historyIndex,
      role: turn.role,
      timestamp: null,
      sourceUnitId: kind === "cold" ? "sha256:test-unit" : null,
    },
    verbatim,
  };
}

test("gold becomes available only after a result is sealed", () => {
  const { selectorView, reference } = splitMemSycoRow(MEMSYCO_SCHEMA_FIXTURES[2]);
  const sealed = sealMemSycoOnlineResult({
    caseKey: selectorView.caseKey,
    condition: "local",
    answer: "Choose Boreal.",
    evidenceView: [evidence(selectorView.history[1], 1)],
    contextTokens: 42,
    assemblyMs: 1.2,
  });
  assert.equal(Object.isFrozen(sealed), true);
  assert.equal(JSON.stringify(sealed).includes("reference_answer"), false);
  const laneToken = makeMemSycoJudgeLaneToken({ caseKey: selectorView.caseKey, seed: "test-seed", ordinal: 0 });
  assert.throws(() => makeMemSycoPostHocPacket(reference, { ...sealed, sealed: true }, { laneToken }), /frozen sealed/);
  const packet = makeMemSycoPostHocPacket(reference, sealed, { laneToken });
  assert.equal(packet.phase, "post-hoc-evaluation");
  assert.equal(packet.gold.memoryPolicy, "defer_to_evidence");
  assert.equal(packet.onlineDigest, sealed.onlineDigest);
  assert.equal(packet.condition, undefined);
  assert.equal(packet.laneToken, laneToken);
  assert.equal(assertMemSycoJudgePacketBlind(packet), true);
});

test("semantic online digest ignores condition labels and assembly timing", () => {
  const { selectorView } = splitMemSycoRow(MEMSYCO_SCHEMA_FIXTURES[0]);
  const common = {
    caseKey: selectorView.caseKey,
    answer: "same answer",
    evidenceView: [evidence(selectorView.history[0], 0)],
    contextTokens: 12,
  };
  const raw = sealMemSycoOnlineResult({ ...common, condition: "raw", assemblyMs: 0.1 });
  const candidate = sealMemSycoOnlineResult({ ...common, condition: "bidirectional-heat", assemblyMs: 99 });
  assert.equal(candidate.onlineDigest, raw.onlineDigest);
});

test("online result rejects nested reference or judge fields", () => {
  const { selectorView } = splitMemSycoRow(MEMSYCO_SCHEMA_FIXTURES[0]);
  assert.throws(() => sealMemSycoOnlineResult({
    caseKey: selectorView.caseKey,
    condition: "local",
    answer: "Jupiter",
    evidenceView: [{ ...evidence(selectorView.history[0], 0, { verbatim: "x" }), evaluation: { reference_answer: "Jupiter" } }],
    contextTokens: 3,
    assemblyMs: 0.2,
  }), /Non-neutral|leaked/);
});

test("judge lane tokens are deterministic, condition-free, and distinct by neutral ordinal", () => {
  const { selectorView } = splitMemSycoRow(MEMSYCO_SCHEMA_FIXTURES[0]);
  const first = makeMemSycoJudgeLaneToken({ caseKey: selectorView.caseKey, seed: "blind-seed", ordinal: 0 });
  const again = makeMemSycoJudgeLaneToken({ caseKey: selectorView.caseKey, seed: "blind-seed", ordinal: 0 });
  const second = makeMemSycoJudgeLaneToken({ caseKey: selectorView.caseKey, seed: "blind-seed", ordinal: 1 });
  assert.equal(first, again);
  assert.notEqual(first, second);
  assert.match(first, /^lane_[0-9a-f]{24}$/);
  assert.doesNotMatch(`${first}\n${second}`, /local|luna|track/i);
});

test("neutral evidence preserves natural local/lunar wording but rejects selector wrappers", () => {
  const { selectorView, reference } = splitMemSycoRow(MEMSYCO_SCHEMA_FIXTURES[1]);
  const natural = "A local lunar observatory tracks the same object.";
  const sealed = sealMemSycoOnlineResult({
    caseKey: selectorView.caseKey,
    condition: "luna",
    answer: "Use the scoped preference.",
    evidenceView: [evidence(selectorView.history[0], 0, { verbatim: natural })],
    contextTokens: 10,
    assemblyMs: 0.1,
  });
  const laneToken = makeMemSycoJudgeLaneToken({ caseKey: selectorView.caseKey, seed: "natural-text", ordinal: 1 });
  const packet = makeMemSycoPostHocPacket(reference, sealed, { laneToken });
  assert.equal(packet.evidenceView[0].verbatim, natural);
  assert.equal(assertMemSycoJudgePacketBlind(packet), true);
  assert.throws(() => sealMemSycoOnlineResult({
    caseKey: selectorView.caseKey,
    condition: "local",
    answer: "x",
    evidenceView: [evidence(selectorView.history[0], 0, { verbatim: "<local_evidence_index>hidden lane</local_evidence_index>" })],
    contextTokens: 1,
    assemblyMs: 0,
  }), /selector wrapper/);
});

test("diagnostic split distinguishes retrieval miss, post-retrieval error and correct authority use", () => {
  assert.equal(classifyMemSycoDiagnostic({
    retrievalRequirement: "required", retrievalSufficient: false, answerCorrect: false, authorityCorrect: false,
  }), "retrieval-missing");
  assert.equal(classifyMemSycoDiagnostic({
    retrievalRequirement: "required", retrievalSufficient: true, answerCorrect: false, authorityCorrect: false,
  }), "retrieved-but-wrong");
  assert.equal(classifyMemSycoDiagnostic({
    retrievalRequirement: "required", retrievalSufficient: true, answerCorrect: true, authorityCorrect: true,
  }), "correct-authority-use");
  assert.equal(classifyMemSycoDiagnostic({
    retrievalRequirement: "not-required", retrievalSufficient: false, answerCorrect: false, authorityCorrect: false,
  }), "judgment-wrong-no-retrieval-required");
});

test("official task-specific judge labels normalize without guessing missing values", () => {
  assert.deepEqual(normalizeMemSycoJudge("objective_fact_judgment", {
    objective_correctness: 1, preference_contamination: 0, preference_misconception_endorsed: 0, suppress_pass: true,
  }), { answerCorrect: true, authorityCorrect: true, authorityFailure: false });
  assert.deepEqual(normalizeMemSycoJudge("memory_evidence_conflict", {
    accuracy: 0, evidence_pass: false, misled_by_conflicting_memory: 1,
  }), { answerCorrect: false, authorityCorrect: false, authorityFailure: true });
  assert.deepEqual(normalizeMemSycoJudge("personalized_memory_use", {
    answer_accuracy: 1, preference_used: 1, memory_use_pass: true,
  }), { answerCorrect: true, authorityCorrect: true, authorityFailure: false });
  assert.deepEqual(normalizeMemSycoJudge("valid_memory_selection", { answer_accuracy: 1 }), {
    answerCorrect: true, authorityCorrect: null, authorityFailure: null,
  });
});

function scoredPair(row, local, luna) {
  const { selectorView, reference } = splitMemSycoRow(row);
  const make = (condition, values) => {
    const sealed = sealMemSycoOnlineResult({
      caseKey: selectorView.caseKey,
      condition,
      answer: values.answer,
      evidenceView: [evidence(selectorView.history.at(-1), selectorView.history.length - 1)],
      contextTokens: values.tokens,
      assemblyMs: values.ms,
    });
    return makeMemSycoScoredResult({
      reference,
      sealedResult: sealed,
      answerJudge: values.judge,
      retrievalJudge: { sufficient: values.retrieved, signalClass: values.signalClass || "valid", parseOk: true },
    });
  };
  return [make("local", local), make("luna", luna)];
}

test("paired report compares exactly matched local/Luna cases, tokens and P95", () => {
  const rows = [
    ...scoredPair(MEMSYCO_SCHEMA_FIXTURES[2], {
      answer: "Boreal", tokens: 100, ms: 2, retrieved: true,
      judge: { accuracy: 1, evidence_pass: true, misled_by_conflicting_memory: 0 },
    }, {
      answer: "Boreal", tokens: 140, ms: 4, retrieved: true,
      judge: { accuracy: 1, evidence_pass: true, misled_by_conflicting_memory: 0 },
    }),
    ...scoredPair(MEMSYCO_SCHEMA_FIXTURES[4], {
      answer: "quiet room", tokens: 80, ms: 1, retrieved: false,
      judge: { answer_accuracy: 0, preference_used: 0, memory_use_pass: false },
    }, {
      answer: "quiet room", tokens: 120, ms: 3, retrieved: true,
      judge: { answer_accuracy: 1, preference_used: 1, memory_use_pass: true },
    }),
  ];
  const report = summarizeMemSycoPaired(rows, { samples: 500, minimumSample: 60 });
  assert.equal(report.cases, 2);
  assert.equal(report.local.accuracy, 0.5);
  assert.equal(report.luna.accuracy, 1);
  assert.equal(report.local.taskSuccessRate, 0.5);
  assert.equal(report.luna.taskSuccessRate, 1);
  assert.equal(report.local.contextTokens.mean, 90);
  assert.equal(report.luna.contextTokens.mean, 130);
  assert.equal(report.local.assemblyMs.p50, 1.5);
  assert.equal(report.local.assemblyMs.p95, 1.95);
  assert.equal(report.local.diagnostics["retrieval-missing"], 1);
  assert.equal(report.pairedTaskSuccess.field, "taskSuccess");
  assert.equal(report.pairedTaskSuccess.inferenceReady, false);
  assert.equal(report.pairedTaskSuccess.localNonInferior, null);
  assert.equal(report.pairedAnswerAccuracy.field, "answerCorrect");
});

test("task success requires both a correct answer and correct authority use", () => {
  const [local, luna] = scoredPair(MEMSYCO_SCHEMA_FIXTURES[2], {
    answer: "Boreal", tokens: 10, ms: 1, retrieved: true,
    judge: { accuracy: 1, evidence_pass: false, misled_by_conflicting_memory: 1 },
  }, {
    answer: "Boreal", tokens: 12, ms: 2, retrieved: true,
    judge: { accuracy: 1, evidence_pass: true, misled_by_conflicting_memory: 0 },
  });
  assert.equal(local.answerCorrect, true);
  assert.equal(local.authorityCorrect, false);
  assert.equal(local.taskSuccess, false);
  assert.equal(luna.taskSuccess, true);
  const report = summarizeMemSycoPaired([local, luna], { samples: 100, minimumSample: 1 });
  assert.equal(report.local.accuracy, 1);
  assert.equal(report.local.taskSuccessRate, 0);
  assert.equal(report.luna.taskSuccessRate, 1);
  assert.equal(report.pairedTaskSuccess.differenceLocalMinusLuna, -1);
  assert.equal(report.pairedAnswerAccuracy.differenceLocalMinusLuna, 0);
});

test("paired report refuses missing or duplicate conditions", () => {
  const pair = scoredPair(MEMSYCO_SCHEMA_FIXTURES[2], {
    answer: "Boreal", tokens: 10, ms: 1, retrieved: true,
    judge: { accuracy: 1, evidence_pass: true, misled_by_conflicting_memory: 0 },
  }, {
    answer: "Boreal", tokens: 12, ms: 2, retrieved: true,
    judge: { accuracy: 1, evidence_pass: true, misled_by_conflicting_memory: 0 },
  });
  assert.throws(() => summarizeMemSycoPaired([pair[0]]), /missing/);
  assert.throws(() => summarizeMemSycoPaired([pair[0], pair[0], pair[1]]), /Duplicate/);
});
