import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptMemoryArenaRow,
  assertNoGoldLeak,
  validateMemoryArenaRow,
} from "./adapter.mjs";

const source = {
  sourceFile: "fixture.jsonl",
  sourceSha256: "f".repeat(64),
  rawLineSha256: "a".repeat(64),
  rowNumber: 1,
  revision: "fixture",
  sourceUri: "fixture://memoryarena",
};

test("shopping row is split into frozen online input and judge-only gold", () => {
  const row = {
    id: 7,
    category: "fixture",
    questions: ["Buy base", "Buy compatible add-on"],
    answers: [
      { target_asin: "A1", attributes: ["base"] },
      { target_asin: "A2", attributes: ["add-on"] },
    ],
  };
  const { onlineCase, referenceCase } = adaptMemoryArenaRow(row, {
    config: "bundled_shopping",
    source,
  });

  assert.equal(onlineCase.sessions.length, 2);
  assert.equal(onlineCase.sessions[1].provenance.sessionOrdinal, 2);
  assert.equal(onlineCase.provenance.sourceTimestamp, undefined);
  assert.equal(Object.isFrozen(onlineCase), true);
  assert.equal(assertNoGoldLeak(onlineCase), true);
  assert.equal(JSON.stringify(onlineCase).includes('"goldAnswers"'), false);
  assert.equal(JSON.stringify(onlineCase).includes('"target_asin"'), false);
  assert.equal(referenceCase.goldAnswers[0].target_asin, "A1");
  assert.equal(referenceCase.successRule, "all-subtasks");
});

test("travel base-person plan is public benchmark background with provenance", () => {
  const row = {
    id: 2,
    base_person: {
      name: "A",
      query: "Plan a two-day trip",
      daily_plans: [{ days: 1 }, { days: 2 }],
    },
    questions: ["B joins A", "C joins A and B"],
    answers: [[{ days: 1 }], [{ days: 1 }]],
  };
  const { onlineCase, referenceCase } = adaptMemoryArenaRow(row, {
    config: "group_travel_planner",
    source,
  });

  assert.equal(onlineCase.initialContext[0].contextId, "base-person");
  assert.equal(onlineCase.initialContext[0].provenance.fieldPaths[0], "base_person");
  assert.deepEqual(onlineCase.sessions[0].initialContextRefs, ["base-person"]);
  assert.equal(referenceCase.successRule, "all-subtasks");
});

test("formal background remains attached to the matching ordered session", () => {
  const row = {
    id: 3,
    paper_name: "fixture-paper",
    questions: ["derive lemma", "apply lemma"],
    answers: ["lemma", "result"],
    backgrounds: ["definitions", "new assumptions"],
  };
  const { onlineCase, referenceCase } = adaptMemoryArenaRow(row, {
    config: "formal_reasoning_math",
    source,
  });

  assert.equal(onlineCase.sessions[0].background, "definitions");
  assert.deepEqual(onlineCase.sessions[1].provenance.fieldPaths, [
    "questions[1]",
    "backgrounds[1]",
  ]);
  assert.equal(referenceCase.successRule, "final-subtask");
  assert.equal(referenceCase.evaluationMetadata.paperName, "fixture-paper");
});

test("strict schema rejects misaligned gold and context", () => {
  assert.throws(
    () =>
      validateMemoryArenaRow(
        { id: 1, questions: ["a", "b"], answers: ["only one"] },
        "progressive_search",
      ),
    /one-to-one/,
  );
  assert.throws(
    () =>
      validateMemoryArenaRow(
        {
          id: 1,
          paper_name: "p",
          questions: ["a", "b"],
          answers: ["x", "y"],
          backgrounds: ["only one"],
        },
        "formal_reasoning_phys",
      ),
    /backgrounds must align/,
  );
});

test("online leak guard rejects evaluator-only keys at any depth", () => {
  assert.throws(
    () =>
      assertNoGoldLeak({
        sessions: [
          { provenance: { sessionOrdinal: 1 } },
          { provenance: { sessionOrdinal: 2 }, nested: { correct_answer: "secret" } },
        ],
      }),
    /Benchmark-private key leaked/,
  );
});
