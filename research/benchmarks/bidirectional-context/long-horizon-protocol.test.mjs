import assert from "node:assert/strict";
import test from "node:test";
import { buildLongHorizonCase, compileLongHorizonAssemblies, targetEvidenceCoverage } from "./long-horizon-fixture.mjs";
import { LONG_HORIZON_CONDITIONS, longHorizonOrder, summarizeLongHorizon } from "./long-horizon-protocol.mjs";

function item(key, topic, turns = 6) {
  const history = [];
  for (let index = 0; index < turns; index += 1) {
    history.push({
      role: index % 2 ? "assistant" : "user",
      content: `${topic} detail ${index}. ${"background material ".repeat(80)}`,
      turnId: `msy:${key}:turn:${index}`,
    });
  }
  return {
    selectorView: { caseKey: `msy:${key}`, question: `What should we do about ${topic}?`, history },
    reference: { caseKey: `msy:${key}`, task: "personalized_memory_use" },
  };
}

test("long-horizon fixture buries target history while dialogue-island recall restores it", () => {
  const target = {
    selectorView: {
      caseKey: "msy:target",
      question: "Which approach best suits the user's travel preferences?",
      history: [
        { role: "user", content: `I dislike crowded travel expos because too many choices overwhelm me. ${"travel background ".repeat(60)}`, turnId: "msy:target:turn:0" },
        { role: "assistant", content: `A quiet one-on-one travel advisor can provide tailored suggestions. ${"travel guidance ".repeat(60)}`, turnId: "msy:target:turn:1" },
        { role: "user", content: `I want one calm, personalized travel plan. ${"travel preference ".repeat(60)}`, turnId: "msy:target:turn:2" },
      ],
    },
    reference: { caseKey: "msy:target", task: "personalized_memory_use" },
  };
  const distractors = Array.from({ length: 8 }, (_, index) => item(`noise${index}`, `compiler topic ${index}`));
  const longCase = buildLongHorizonCase(target, distractors, { targetAfter: 2 });
  const assemblies = compileLongHorizonAssemblies(longCase, { rawBudget: 32768, compactBudget: 4096 });
  assert.ok(longCase.targetRange.end < longCase.selectorView.history.length - 20);
  assert.equal(targetEvidenceCoverage(longCase, assemblies["raw-long"]), 1);
  assert.equal(targetEvidenceCoverage(longCase, assemblies["rolling-extractive"]), 0);
  assert.ok(targetEvidenceCoverage(longCase, assemblies["evidence-ladder"]) >= 2 / 3);
  assert.match(assemblies["evidence-ladder"].context, /one-on-one travel advisor/);
  assert.ok(assemblies["evidence-ladder"].contextTokens < assemblies["raw-long"].contextTokens / 2);
});

test("three-way order is deterministic and complete", () => {
  const first = longHorizonOrder("msy:abc", "seed");
  assert.deepEqual(first, longHorizonOrder("msy:abc", "seed"));
  assert.deepEqual([...first].sort(), [...LONG_HORIZON_CONDITIONS].sort());
});

test("long-horizon gate rewards significant rolling improvement without trading raw safety", () => {
  const rows = [];
  for (let index = 0; index < 4; index += 1) {
    const common = { caseKey: `msy:${index}`, task: "personalized_memory_use", answerCorrect: true, retrievalSufficient: true, retrievalRequirement: "required", retrievalSignalClass: "supporting", retrievalJudgeParseOk: true, answerJudgeParseOk: true, diagnostic: "correct-authority-use" };
    rows.push({ ...common, condition: "raw-long", taskSuccess: true, authorityCorrect: true, contextTokens: 20000, assemblyMs: 2 });
    rows.push({ ...common, condition: "rolling-extractive", taskSuccess: false, authorityCorrect: false, contextTokens: 8000, assemblyMs: 1 });
    rows.push({ ...common, condition: "evidence-ladder", taskSuccess: true, authorityCorrect: true, contextTokens: 4000, assemblyMs: 3 });
  }
  const summary = summarizeLongHorizon(rows);
  assert.equal(summary.taskVsRolling.oneSidedExactMcNemarP, 0.0625);
  assert.equal(summary.gate.passed, true);
});
