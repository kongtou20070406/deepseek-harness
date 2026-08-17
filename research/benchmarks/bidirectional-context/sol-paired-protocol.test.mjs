import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { sealMemSycoOnlineResult } from "../memsyco/protocol.mjs";
import {
  SOL_PAIRED_CONDITIONS,
  assertSolOnlyModel,
  assertSolRunAuthorized,
  judgeSolPairedFrozen,
  runSolPairedOnline,
  solPairedOrder,
  summarizeSolPaired,
} from "./sol-paired-protocol.mjs";

const data = resolve("research/benchmarks/third_party/memsyco");

function evidence(selectorView) {
  const turn = selectorView.history[0];
  return [{
    kind: "cold",
    provenance: { turnId: turn.turnId, historyIndex: 0, role: turn.role, timestamp: null, sourceUnitId: "sha256:test" },
    verbatim: turn.content,
  }];
}

test("Sol pair order is deterministic, balanced, and judge-reversed", () => {
  const seed = "sol-lsc-epc-5pct-v1";
  let rawFirst = 0;
  let lscFirst = 0;
  for (let index = 0; index < 100; index += 1) {
    const key = `msy:case-${index}`;
    const order = solPairedOrder(key, seed);
    assert.deepEqual([...order].sort(), [...SOL_PAIRED_CONDITIONS].sort());
    assert.deepEqual(solPairedOrder(key, seed, { judge: true }), [...order].reverse());
    if (order[0] === "raw") rawFirst += 1;
    else lscFirst += 1;
  }
  assert.ok(rawFirst >= 35 && lscFirst >= 35, `${rawFirst}/${lscFirst} is unexpectedly imbalanced`);
});

test("model and authorization gates fail closed", () => {
  assert.equal(assertSolOnlyModel("openai-codex/gpt-5.6-sol"), "gpt-5.6-sol");
  assert.throws(() => assertSolOnlyModel("gpt-5.6-luna"), /must be gpt-5.6-sol/);
  assert.throws(() => assertSolRunAuthorized({}), /explicit --authorized-model-run/);
  assert.equal(assertSolRunAuthorized({ authorized: true }), true);
  assert.equal(assertSolRunAuthorized({ dryRun: true }), true);
  assert.equal(assertSolRunAuthorized({ validateOnly: true }), true);
});

test("online pair exposes no gold and seals both conditions before judging", async () => {
  const loaded = await loadMemSycoBench(data);
  const item = loaded.cases[0];
  const sharedEvidence = evidence(item.selectorView);
  const seen = [];
  const sealed = await runSolPairedOnline({
    selectorView: item.selectorView,
    conditionOrder: solPairedOrder(item.selectorView.caseKey, "seed"),
    assemblies: {
      raw: { context: sharedEvidence[0].verbatim, evidenceView: sharedEvidence, contextTokens: 10, assemblyMs: 0.1 },
      "bidirectional-heat": { context: sharedEvidence[0].verbatim, evidenceView: sharedEvidence, contextTokens: 10, assemblyMs: 0.1 },
    },
    answer: async ({ prompt }) => {
      assert.doesNotMatch(prompt, /reference_answer|memoryPolicy|evaluation|rubric/i);
      seen.push(prompt);
      return "A concise frozen answer.";
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(Object.isFrozen(sealed.raw), true);
  assert.equal(Object.isFrozen(sealed["bidirectional-heat"]), true);
});

test("identical frozen outcomes are judged once through a condition-blind lane", async () => {
  const loaded = await loadMemSycoBench(data);
  const item = loaded.cases[0];
  const sharedEvidence = evidence(item.selectorView);
  const make = (condition) => sealMemSycoOnlineResult({
    caseKey: item.reference.caseKey,
    condition,
    answer: "A concise frozen answer.",
    evidenceView: sharedEvidence,
    contextTokens: 10,
    assemblyMs: 0.1,
  });
  let calls = 0;
  const scored = await judgeSolPairedFrozen({
    reference: item.reference,
    sealedByCondition: { raw: make("raw"), "bidirectional-heat": make("bidirectional-heat") },
    seed: "seed",
    judge: async ({ laneToken, prompt }) => {
      calls += 1;
      assert.match(laneToken, /^lane_[0-9a-f]{24}$/);
      assert.doesNotMatch(prompt, /"condition"\s*:/i);
      return JSON.stringify({
        objective_correctness: true,
        suppress_pass: true,
        preference_contamination: false,
        preference_misconception_endorsed: false,
        retrieval_sufficient: false,
        retrieval_signal_class: "unnecessary",
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(scored.length, 2);
});

function scored(caseKey, condition, { taskSuccess = true, authorityCorrect = true } = {}) {
  return {
    caseKey,
    task: "objective_fact_judgment",
    condition,
    contextTokens: condition === "raw" ? 2000 : 1100,
    assemblyMs: 0.2,
    answerCorrect: taskSuccess,
    authorityCorrect,
    taskSuccess: taskSuccess && authorityCorrect,
    diagnostic: taskSuccess && authorityCorrect ? "correct-authority-use" : "retrieved-but-wrong",
  };
}

test("paired summary gates token claims behind task and authority non-inferiority", () => {
  const rows = [];
  for (let index = 0; index < 60; index += 1) {
    const key = `msy:summary-${index}`;
    rows.push(scored(key, "raw"), scored(key, "bidirectional-heat"));
  }
  const equal = summarizeSolPaired(rows, { samples: 2_000, seed: "summary" });
  assert.equal(equal.adoptionGate.performanceGatePassed, true);
  assert.equal(equal.adoptionGate.tokenComparisonEligible, true);
  assert.equal(equal.pairedTaskSuccess.differenceLscMinusRaw, 0);

  rows[1] = scored("msy:summary-0", "bidirectional-heat", { taskSuccess: false, authorityCorrect: false });
  const regression = summarizeSolPaired(rows, { samples: 2_000, seed: "summary" });
  assert.equal(regression.regressions.length, 1);
  assert.equal(regression.adoptionGate.performanceGatePassed, false);
  assert.equal(regression.adoptionGate.tokenComparisonEligible, false);
});
