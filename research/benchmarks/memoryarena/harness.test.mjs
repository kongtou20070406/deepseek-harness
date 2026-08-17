import assert from "node:assert/strict";
import test from "node:test";

import { adaptMemoryArenaRow } from "./adapter.mjs";
import { runPairedMemoryArenaProtocol } from "./harness.mjs";

const adapted = adaptMemoryArenaRow(
  {
    id: 1,
    questions: ["find a candidate", "refine it"],
    answers: ["candidate", "final"],
  },
  {
    config: "progressive_search",
    source: {
      sourceUri: "fixture://memoryarena",
      sourceFile: "fixture.jsonl",
      sourceSha256: "f".repeat(64),
      rawLineSha256: "a".repeat(64),
      rowNumber: 1,
      revision: "fixture",
    },
  },
);

const dataset = {
  manifest: {
    benchmark: "MemoryArena",
    officialSnapshotVerified: false,
  },
  onlineCases: [adapted.onlineCase],
  referencesByCaseKey: new Map([[adapted.referenceCase.caseKey, adapted.referenceCase]]),
};

function executor({ onlineCase, requestedCondition, openTrace }) {
  assert.equal(Object.hasOwn(onlineCase, "goldAnswers"), false);
  const recorder = openTrace({ effective: requestedCondition });
  for (const session of onlineCase.sessions) {
    recorder.startSession(session.sessionId);
    recorder.recordAction(session.sessionId, { content: "fixture action", model: "fixture" });
    recorder.recordFeedback(session.sessionId, {
      observation: { state: "fixture feedback" },
      reward: 1,
      done: true,
    });
  }
  return {
    condition: { effective: requestedCondition },
    trace: recorder.finish(),
    outputs: ["candidate", "final"],
    tokenUsage: {
      mainInputTokens: 20,
      mainOutputTokens: 5,
      injectedContextTokens: 8,
      lunaInputTokens: requestedCondition === "luna" ? 5 : 0,
      lunaOutputTokens: requestedCondition === "luna" ? 2 : 0,
    },
    loopMetrics: [{ assemblyMs: 2, injectedContextTokens: 8 }],
  };
}

function judge({ referenceCase, execution }) {
  return {
    subtaskResults: referenceCase.goldAnswers.map((answer, index) => ({
      sessionOrdinal: index + 1,
      passed: execution.outputs[index] === answer,
    })),
  };
}

test("paired fixture protocol keeps gold behind the judge boundary", async () => {
  const result = await runPairedMemoryArenaProtocol({
    dataset,
    localExecutor: executor,
    lunaExecutor: executor,
    judge,
    comparability: {
      agentModel: "fixture",
      judgeVersion: "exact-match-fixture",
      seed: 1,
      maxSteps: 1,
    },
  });

  assert.equal(result.resultClass, "fixture");
  assert.equal(result.report.strict.local.taskSuccessRate, 1);
  assert.equal(result.report.strict.luna.taskSuccessRate, 1);
  assert.equal(result.report.strict.delta.localWithinTenPercentagePoints, true);
});

test("unverified data cannot be labelled as an official benchmark result", async () => {
  await assert.rejects(
    runPairedMemoryArenaProtocol({
      dataset,
      localExecutor: executor,
      lunaExecutor: executor,
      judge,
      evaluation: {
        kind: "official",
        environment: { sourceUrl: "https://github.com/ZexueHe/MemoryArena", revision: "abcdef1" },
        evaluator: { sourceUrl: "https://github.com/ZexueHe/MemoryArena", revision: "abcdef1" },
      },
    }),
    /content-verified official/,
  );
});

test("executor cannot rewrite the assigned requested condition", async () => {
  const adversarialExecutor = ({ onlineCase, requestedCondition, openTrace }) => {
    const recorder = openTrace({ requested: "local", effective: requestedCondition });
    for (const session of onlineCase.sessions) {
      recorder.startSession(session.sessionId);
      recorder.recordAction(session.sessionId, { content: "fixture action" });
      recorder.recordFeedback(session.sessionId, {
        observation: { state: "fixture feedback" },
        done: true,
      });
    }
    return {
      condition: { requested: "local", effective: requestedCondition },
      trace: recorder.finish(),
      outputs: ["candidate", "final"],
    };
  };

  const result = await runPairedMemoryArenaProtocol({
    dataset,
    localExecutor: adversarialExecutor,
    lunaExecutor: adversarialExecutor,
    judge,
  });
  assert.equal(result.localRuns[0].condition.requested, "local");
  assert.equal(result.lunaRuns[0].condition.requested, "luna");
});
