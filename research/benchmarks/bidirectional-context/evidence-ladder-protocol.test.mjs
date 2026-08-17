import assert from "node:assert/strict";
import test from "node:test";
import { EVIDENCE_LADDER_CONDITIONS, evidenceLadderOrder, summarizeEvidenceLadder } from "./evidence-ladder-protocol.mjs";

test("evidence ladder pair order is deterministic and judge-reversed", () => {
  for (let index = 0; index < 50; index += 1) {
    const key = `msy:ladder-${index}`;
    const order = evidenceLadderOrder(key, "seed");
    assert.deepEqual([...order].sort(), [...EVIDENCE_LADDER_CONDITIONS].sort());
    assert.deepEqual(evidenceLadderOrder(key, "seed", { judge: true }), [...order].reverse());
  }
});

function row(caseKey, condition, { success = true, authority = true } = {}) {
  return {
    caseKey,
    task: "objective_fact_judgment",
    condition,
    contextTokens: condition === "raw" ? 2000 : 1200,
    assemblyMs: 1,
    answerCorrect: success,
    authorityCorrect: authority,
    taskSuccess: success && authority,
    diagnostic: success && authority ? "correct-authority-use" : "retrieved-but-wrong",
  };
}

test("screening gate requires paired improvement, authority safety, compression, and latency", () => {
  const rows = [];
  for (let index = 0; index < 32; index += 1) {
    const key = `msy:gate-${index}`;
    rows.push(row(key, "raw", { success: index >= 4 }), row(key, "evidence-ladder"));
  }
  const summary = summarizeEvidenceLadder(rows, { seed: "gate" });
  assert.equal(summary.pairedTask.discordant.candidateOnly, 4);
  assert.equal(summary.pairedTask.oneSidedExactMcNemarP, 0.0625);
  assert.equal(summary.gate.passed, true);

  rows[1] = row("msy:gate-0", "evidence-ladder", { success: false, authority: false });
  const unsafe = summarizeEvidenceLadder(rows, { seed: "gate" });
  assert.equal(unsafe.gate.authorityNonInferior, false);
  assert.equal(unsafe.gate.passed, false);
});
