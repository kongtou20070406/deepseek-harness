import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GARAGE_OFFICIAL_DATA,
  assertGarageOfficialFingerprint,
  assertNoGarageGoldLeak,
  loadGarageBench,
  splitGarageRow,
  validateGarageRow,
} from "./adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const officialRoot = join(here, "..", "third_party", "garage");
const officialPromise = loadGarageBench(officialRoot);

function fixtureRow() {
  return {
    sample_id: "3e85c5e3-ac81-484f-bee3-9cba1000169f",
    question_date: "17 December 2024",
    grounding: [
      { age: "6 days", date: "not defined", provider: "web", cite_1: " Exact first passage." },
      { age: "not defined", date: "Published date: N/A", provider: "ent", cite_2: " Exact second passage." },
    ],
    question: "Which evidence answers the question?",
    question_valid: "YES",
    question_false_premise: "NO",
    question_seeking: "YES",
    question_sensitive: "YES",
    question_type: "FAST-CHANGING",
    question_complexity: "Comparison",
    question_category: "Finance",
    question_popularity: "Tail",
    evidence_relevant: ["YES", "NO"],
    evidence_correct: ["ANSWER-THE-QUESTION", "OUTDATED"],
    answer_generate: "A judge-only answer.[cite_1]",
    answer_related_info: "",
    answer_validate: "YES",
    comments: "judge-only comment",
    evidence_cited: ["YES", "NO"],
    question_tag: "web",
    topic_tag: "sec",
  };
}

test("official GaRAGe release passes pinned hash, byte, row, passage and schema checks", async () => {
  const loaded = await officialPromise;
  assert.equal(loaded.sourceBytes, GARAGE_OFFICIAL_DATA.bytes);
  assert.equal(loaded.sourceSha256, `sha256:${GARAGE_OFFICIAL_DATA.sha256}`);
  assert.equal(loaded.cases.length, GARAGE_OFFICIAL_DATA.rows);
  assert.equal(loaded.stats.questions, 2_366);
  assert.equal(loaded.stats.passages, 35_351);
  assert.deepEqual(loaded.stats.providers, { ent: 4_752, web: 30_599 });
  assert.deepEqual(loaded.stats.categories.complexity, {
    Aggregation: 55,
    Comparison: 355,
    "Multi-hop": 713,
    "Post-processing heavy": 696,
    Set: 278,
    Simple: 54,
    "Simple w. condition": 215,
  });
  assert.deepEqual(loaded.stats.eligibilityLabels, {
    "answer-unvalidated": 427,
    "answer-validated": 1_939,
    "answerable-grounding": 1_901,
    "contains-outdated": 606,
    "insufficient-grounding": 105,
    "mixed-provider": 1_156,
    "no-outdated": 1_760,
    "not-time-sensitive": 780,
    "relevant-only-grounding": 360,
    "single-provider": 1_210,
    "time-sensitive": 1_586,
  });
});

test("all 2366 official selector views pass recursive no-leak checks", async () => {
  const loaded = await officialPromise;
  for (const { selectorView, reference } of loaded.cases) {
    assert.equal(assertNoGarageGoldLeak(selectorView), true);
    assert.equal(Object.hasOwn(selectorView, "sample_id"), false);
    assert.equal(Object.hasOwn(selectorView, "questionSensitive"), false);
    assert.equal(Object.hasOwn(selectorView, "questionComplexity"), false);
    assert.equal(Object.hasOwn(selectorView, "evidence_relevant"), false);
    assert.equal(Object.hasOwn(selectorView, "answer_generate"), false);
    assert.equal(reference.passageJudgments.length, selectorView.passages.length);
  }
});

test("online view preserves exact text and independent source/time/citation provenance", () => {
  const row = fixtureRow();
  const { selectorView, reference } = splitGarageRow(row);
  assert.equal(selectorView.question, row.question);
  assert.equal(selectorView.questionDate, row.question_date);
  assert.equal(selectorView.passages[0].text, row.grounding[0].cite_1);
  assert.deepEqual(selectorView.passages[0].provenance, {
    provider: "web",
    sourceDate: "not defined",
    sourceAge: "6 days",
    citationId: "cite_1",
    citationOrdinal: 1,
    questionDate: "17 December 2024",
  });
  assert.deepEqual(selectorView.passages[1].provenance, {
    provider: "ent",
    sourceDate: "Published date: N/A",
    sourceAge: "not defined",
    citationId: "cite_2",
    citationOrdinal: 2,
    questionDate: "17 December 2024",
  });
  assert.equal(reference.questionAnnotations.sensitive, "YES");
  assert.equal(reference.questionAnnotations.complexity, "Comparison");
  assert.equal(JSON.stringify(selectorView).includes(row.answer_generate), false);
  assert.equal(JSON.stringify(selectorView).includes(row.sample_id), false);
});

test("recursive leak guard rejects renamed/nested judge fields and unknown online structure", () => {
  const { selectorView } = splitGarageRow(fixtureRow());
  const nestedLeak = structuredClone(selectorView);
  nestedLeak.passages[0].provenance.evidence_correct = "ANSWER-THE-QUESTION";
  assert.throws(() => assertNoGarageGoldLeak(nestedLeak), /gold\/judge field leaked/);

  const unknown = structuredClone(selectorView);
  unknown.passages[0].provenance.helperHint = "maybe relevant";
  assert.throws(() => assertNoGarageGoldLeak(unknown), /unsupported field/);
});

test("strict row validation rejects extra fields, label misalignment and citation drift", () => {
  const extra = fixtureRow();
  extra.question_hint = "leak";
  assert.throws(() => validateGarageRow(extra), /unsupported field/);

  const misaligned = fixtureRow();
  misaligned.evidence_relevant = ["YES"];
  assert.throws(() => validateGarageRow(misaligned), /align one-to-one/);

  const drifted = fixtureRow();
  drifted.grounding[1] = { age: "x", date: "y", provider: "web", cite_9: "wrong identity" };
  assert.throws(() => validateGarageRow(drifted), /unsupported field/);
});

test("fingerprint check fails closed for non-official bytes", () => {
  assert.throws(() => assertGarageOfficialFingerprint(Buffer.from("not GaRAGe")), /byte-size mismatch/);
});
