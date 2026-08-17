import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoCameLabelLeak,
  cameSelectorToPiMessages,
  loadDecodedCameBench,
  splitCameQuestion,
} from "./adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const turns = [
  { id: "t1", role: "user", content: "Compare Apollo for Day 1.", partition: ["trip", "day-1"], action: "COMPARE", action_object: "Apollo", timestamp_mapping: { "day-1": "2026-01-01" } },
  { id: "t2", role: "assistant", content: "Apollo costs 90.", partition: ["trip", "day-1"], action: "PROPOSE", action_object: "Apollo", timestamp_mapping: { "day-1": "2026-01-01" } },
];

test("CAME adapter separates all answer and gold structural labels", () => {
  const { selectorView, reference } = splitCameQuestion({
    id: "q1", type: "type_2", content: "What did Apollo cost for Day 1?", date: "2026-01-02",
    question_turn_ids: ["t1", "t2"], answer_turn_ids: ["t2"],
    answer: { free_form_answer: "[\"90\"]" }, answer_type: "ANSWER_TYPE_FREEFORM",
  }, turns);
  assert.equal(assertNoCameLabelLeak(selectorView), true);
  assert.deepEqual(reference.answer, ["90"]);
  assert.deepEqual(reference.answerTurnIds, ["t2"]);
  assert.equal(selectorView.turns[1].content, "Apollo costs 90.");
  assert.equal(Object.hasOwn(selectorView.turns[1], "partition"), false);
  assert.equal(Object.hasOwn(selectorView.turns[1], "action"), false);
});

test("CAME adapter preserves actor, independent time provenance and event identity", () => {
  const { selectorView } = splitCameQuestion({
    id: "q1", content: "question", question_turn_ids: ["t1", "t2"], answer_turn_ids: [], answer: {},
  }, turns);
  const messages = cameSelectorToPiMessages(selectorView);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /id=t1/);
  assert.match(messages[0].content, /actor="user"/);
  assert.match(messages[0].content, /day-1="2026-01-01"/);
});

test("official decoded CAME data passes the no-leak adapter contract", async () => {
  const root = join(here, "..", "third_party", "came-bench", "decoded_benchmark_codec");
  const loaded = await loadDecodedCameBench(root);
  assert.equal(loaded.trajectories, 14);
  assert.equal(loaded.cases.length, 373);
  assert.equal(loaded.sha256, "sha256:a965affaf69664332d40d0d1f93c0149e8485e26303f48a05a5d3517c1d81036");
  for (const { selectorView } of loaded.cases) assertNoCameLabelLeak(selectorView);
});
