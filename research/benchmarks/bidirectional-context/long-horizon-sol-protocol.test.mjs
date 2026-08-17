import assert from "node:assert/strict";
import test from "node:test";
import { LONG_HORIZON_SOL_CONDITIONS, longHorizonSolOrder, summarizeLongHorizonSol } from "./long-horizon-sol-protocol.mjs";

test("formal Sol pair order is deterministic, complete, and judge reversed", () => {
  const answer = longHorizonSolOrder("msy:formal", "seed");
  assert.deepEqual(answer, longHorizonSolOrder("msy:formal", "seed"));
  assert.deepEqual([...answer].sort(), [...LONG_HORIZON_SOL_CONDITIONS].sort());
  assert.deepEqual(longHorizonSolOrder("msy:formal", "seed", { judge: true }), [...answer].reverse());
});

test("formal gate requires 60 cases, paired safety, compression, and latency", () => {
  const rows = [];
  for (let index = 0; index < 60; index += 1) {
    const common = { caseKey: `msy:${index}`, task: "valid_memory_selection", answerCorrect: true, authorityCorrect: true, taskSuccess: true, diagnostic: "correct-authority-use" };
    rows.push({ ...common, condition: "raw-long", contextTokens: 20000, assemblyMs: 5 });
    rows.push({ ...common, condition: "evidence-ladder", contextTokens: 2000, assemblyMs: 30 });
  }
  const summary = summarizeLongHorizonSol(rows);
  assert.equal(summary.gate.passed, true);
  assert.equal(summary.compression, 0.9);
});
