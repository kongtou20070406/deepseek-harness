import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateMemoryArenaRuns,
  comparePairedMemoryArenaRuns,
  quantileLinear,
  scoreMemoryArenaRun,
} from "./metrics.mjs";

const references = new Map([
  [
    "shopping",
    {
      caseKey: "shopping",
      config: "bundled_shopping",
      successRule: "all-subtasks",
      goldAnswers: [{}, {}, {}],
    },
  ],
  [
    "search",
    {
      caseKey: "search",
      config: "progressive_search",
      successRule: "final-subtask",
      goldAnswers: ["a", "b", "c"],
    },
  ],
]);

function run(caseKey, config, requested, passed, overrides = {}) {
  return {
    caseKey,
    config,
    condition: { requested, effective: requested },
    subtaskResults: passed.map((value, index) => ({
      sessionOrdinal: index + 1,
      passed: value,
    })),
    tokenUsage: {
      mainInputTokens: 100,
      mainOutputTokens: 20,
      injectedContextTokens: 30,
      lunaInputTokens: requested === "luna" ? 40 : 0,
      lunaOutputTokens: requested === "luna" ? 10 : 0,
    },
    loopMetrics: [
      { assemblyMs: 1, injectedContextTokens: 10 },
      { assemblyMs: 9, injectedContextTokens: 20 },
    ],
    comparability: { agentModel: "fixture", judgeVersion: "fixture", seed: 7, maxSteps: 4 },
    resultClass: "fixture",
    ...overrides,
  };
}

test("MemoryArena domain-specific success rules and progress are distinct", () => {
  const shopping = scoreMemoryArenaRun(
    run("shopping", "bundled_shopping", "local", [true, false, true]),
    references.get("shopping"),
  );
  const search = scoreMemoryArenaRun(
    run("search", "progressive_search", "local", [false, false, true]),
    references.get("search"),
  );

  assert.equal(shopping.taskSuccess, false);
  assert.equal(shopping.taskProgress, 2 / 3);
  assert.equal(search.taskSuccess, true);
  assert.equal(search.taskProgress, 1 / 3);
});

test("aggregate reports Task Success, Progress, tokens, and assembly P95", () => {
  const report = aggregateMemoryArenaRuns(
    [
      run("shopping", "bundled_shopping", "local", [true, true, true]),
      run("search", "progressive_search", "local", [false, false, true]),
    ],
    references,
  );

  assert.equal(report.taskSuccessRate, 1);
  assert.equal(report.taskProgressScore, 2 / 3);
  assert.equal(report.tokens.totals.injectedContextTokens, 60);
  assert.equal(report.tokens.totals.totalModelTokens, 240);
  assert.equal(report.assemblyLatency.p95Ms, 9);
  assert.equal(report.byConfig.bundled_shopping.taskSuccessRate, 1);
});

test("paired report excludes Luna-to-local fallback from strict comparison", () => {
  const local = [run("shopping", "bundled_shopping", "local", [true, true, true])];
  const lunaFallback = [
    run("shopping", "bundled_shopping", "luna", [true, true, true], {
      condition: {
        requested: "luna",
        effective: "local",
        fallbackReason: "luna-unavailable",
        fallbackWaitMs: 0,
      },
    }),
  ];
  const report = comparePairedMemoryArenaRuns(local, lunaFallback, references);

  assert.equal(report.pairedCaseCount, 1);
  assert.equal(report.strictPairedCaseCount, 0);
  assert.deepEqual(report.excludedFallbackCaseKeys, ["shopping"]);
  assert.equal(report.strict, null);
  assert.equal(report.requested.luna.fallback.rate, 1);
});

test("linear quantile is deterministic", () => {
  assert.ok(Math.abs(quantileLinear([1, 2, 10, 20], 0.95) - 18.5) < Number.EPSILON * 20);
});
