import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRunBudgetLedger, conservativeModelReservation } from "./model-run-budget.mjs";

test("generic model ledger enforces model, token, and call contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sol-budget-"));
  try {
    const path = join(root, "ledger.json");
    const ledger = await new ModelRunBudgetLedger({
      path,
      model: "gpt-5.6-sol",
      hardTokenLimit: 1000,
      hardCallLimit: 2,
      reservationEstimator: () => 400,
    }).load();
    const one = ledger.reserve({ prompt: "a", catalogMaxOutput: 1, runId: "r", caseId: "c1", lane: "answer" });
    await ledger.settle(one, { input: 10, output: 5 });
    const two = ledger.reserve({ prompt: "b", catalogMaxOutput: 1, runId: "r", caseId: "c2", lane: "judge" });
    await ledger.settle(two, { input: 12, output: 3 });
    assert.equal(ledger.snapshot().calls, 2);
    assert.throws(() => ledger.reserve({ prompt: "c", runId: "r", caseId: "c3", lane: "answer" }), /call budget refused/);
    await assert.rejects(() => new ModelRunBudgetLedger({
      path, model: "gpt-5.6-luna", hardTokenLimit: 1000, hardCallLimit: 2,
    }).load(), /model mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reservation accounts for prompt bytes and uncapped Pi catalog output", () => {
  assert.equal(conservativeModelReservation("abc", 128000), 3 + 128000 + 65536);
});
