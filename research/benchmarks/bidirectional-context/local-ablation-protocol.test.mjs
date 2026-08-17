import assert from "node:assert/strict";
import test from "node:test";
import { splitMemSycoRow } from "../memsyco/adapter.mjs";
import { MEMSYCO_SCHEMA_FIXTURES } from "../memsyco/fixtures.mjs";
import { MEMSYCO_LOCAL_ABLATION_CONDITIONS } from "../memsyco/protocol.mjs";
import {
  judgeLocalAblationFrozen,
  localAblationOrder,
  neutralEvidenceFromCompilation,
  runLocalAblationOnline,
  summarizeLocalAblation,
} from "./local-ablation-protocol.mjs";

function fixture(task = "memory_evidence_conflict") {
  return splitMemSycoRow(structuredClone(MEMSYCO_SCHEMA_FIXTURES.find((row) => row.task === task)));
}

test("five-condition order is deterministic, complete, and independently shuffled for judging", () => {
  const first = localAblationOrder("msy:test", "seed-a");
  const again = localAblationOrder("msy:test", "seed-a");
  const judge = localAblationOrder("msy:test", "seed-a", { judge: true });
  assert.deepEqual(first, again);
  assert.deepEqual(new Set(first), new Set(MEMSYCO_LOCAL_ABLATION_CONDITIONS));
  assert.deepEqual(new Set(judge), new Set(MEMSYCO_LOCAL_ABLATION_CONDITIONS));
});

test("selected evidence is a verbatim condition-neutral MemSyco sidecar", () => {
  const item = fixture("personalized_memory_use");
  const history = item.selectorView.history;
  const sidecar = neutralEvidenceFromCompilation(item.selectorView, {
    selectedBlocks: history.slice(0, 1).map((turn) => ({
      blockId: "a".repeat(64),
      role: turn.role,
      raw: turn.content,
      provenance: { entryId: turn.turnId },
    })),
  });
  assert.equal(sidecar[0].verbatim, history[0].content);
  assert.equal(sidecar[0].provenance.historyIndex, 0);
  assert.doesNotMatch(JSON.stringify(sidecar), /positive-only|gc-only|bidirectional/i);
});

test("identical frozen outcomes are judged once while all five conditions are scored", async () => {
  const item = fixture();
  const history = item.selectorView.history;
  const evidenceView = history.slice(0, 1).map((turn, historyIndex) => ({
    kind: "cold",
    provenance: { turnId: turn.turnId, historyIndex, role: turn.role, timestamp: null, sourceUnitId: "sha256:test" },
    verbatim: turn.content,
  }));
  const assemblies = Object.fromEntries(MEMSYCO_LOCAL_ABLATION_CONDITIONS.map((condition) => [condition, {
    context: "same online context",
    contextTokens: 10,
    assemblyMs: 0.1,
    evidenceView,
    overflow: false,
  }]));
  let answers = 0;
  const sealed = await runLocalAblationOnline({
    selectorView: item.selectorView,
    conditionOrder: localAblationOrder(item.selectorView.caseKey, "dedupe"),
    assemblies,
    answer: async () => { answers += 1; return { text: "Choose Boreal." }; },
  });
  assert.equal(answers, MEMSYCO_LOCAL_ABLATION_CONDITIONS.length, "prompt caching is an orchestration concern, not protocol state");
  let judges = 0;
  const scored = await judgeLocalAblationFrozen({
    reference: item.reference,
    sealedByCondition: sealed,
    seed: "dedupe",
    judge: async ({ laneToken, prompt }) => {
      judges += 1;
      assert.match(laneToken, /^lane_[0-9a-f]{24}$/);
      assert.doesNotMatch(prompt, /positive-only|gc-only|bidirectional/i);
      return JSON.stringify({ accuracy: true, evidence_pass: true, misled_by_conflicting_memory: false, retrieval_sufficient: true });
    },
  });
  assert.equal(judges, 1);
  assert.equal(scored.length, MEMSYCO_LOCAL_ABLATION_CONDITIONS.length);
  assert.equal(scored.every((row) => row.taskSuccess), true);
});

test("five-way summary keeps task success primary and withholds inference below 60 cases", async () => {
  const item = fixture();
  const evidenceView = [{
    kind: "cold",
    provenance: { turnId: item.selectorView.history[0].turnId, historyIndex: 0, role: item.selectorView.history[0].role, timestamp: null, sourceUnitId: "sha256:test" },
    verbatim: item.selectorView.history[0].content,
  }];
  const assemblies = Object.fromEntries(MEMSYCO_LOCAL_ABLATION_CONDITIONS.map((condition, index) => [condition, {
    context: `context ${index}`,
    contextTokens: 10 + index,
    assemblyMs: index,
    evidenceView,
    overflow: false,
  }]));
  const sealed = await runLocalAblationOnline({
    selectorView: item.selectorView,
    conditionOrder: MEMSYCO_LOCAL_ABLATION_CONDITIONS,
    assemblies,
    answer: async () => ({ text: "Choose Boreal." }),
  });
  const scored = await judgeLocalAblationFrozen({
    reference: item.reference,
    sealedByCondition: sealed,
    seed: "summary",
    judge: async () => JSON.stringify({ accuracy: true, evidence_pass: true, misled_by_conflicting_memory: false, retrieval_sufficient: true }),
  });
  const summary = summarizeLocalAblation(scored, { samples: 100, minimumSample: 60 });
  assert.equal(summary.cases, 1);
  assert.equal(summary.conditions["positive-only"].taskSuccessRate, 1);
  assert.equal(summary.conditions["bidirectional-heat"].contextTokens.mean, 14);
  assert.equal(summary.comparisonsToPositiveOnly.bidirectional.inferenceReady, false);
  assert.equal(summary.comparisonsToPositiveOnly.bidirectional.nonInferior, null);
});
