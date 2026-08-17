import assert from "node:assert/strict";
import test from "node:test";

import { splitGarageRow } from "./adapter.mjs";
import {
  diagnoseGarageSelection,
  fixedStratifiedGarageSample,
  garageSampleManifest,
} from "./metrics.mjs";
import {
  selectJudgmentEvidenceSet,
  selectWithProductionLocal,
  selectionContext,
} from "./selector.mjs";

function fixtureRow(overrides = {}) {
  const passages = [
    { age: "1 day", date: "16 December 2024", provider: "web", cite_1: "As of December 2024, Jane Li is Acme's CEO and approved the Atlas expansion plan." },
    { age: "1 day", date: "16 December 2024", provider: "web", cite_2: "Jane Li serves as CEO of Acme and she approved its Atlas expansion plan in December 2024." },
    { age: "4 years", date: "20 December 2020", provider: "ent", cite_3: "In 2020, John Roe was Acme's CEO and approved the earlier Beacon plan." },
    { age: "2 days", date: "15 December 2024", provider: "ent", cite_4: "The Atlas expansion plan adds a Singapore laboratory and a Seoul laboratory." },
    { age: "3 days", date: "14 December 2024", provider: "web", cite_5: "Acme reported quarterly revenue of ten million dollars." },
  ];
  return {
    sample_id: "11111111-1111-4111-8111-111111111111",
    question_date: "17 December 2024",
    grounding: passages,
    question: "As of 17 December 2024, who is Acme's CEO and which expansion plan did that CEO approve?",
    question_valid: "YES",
    question_false_premise: "NO",
    question_seeking: "YES",
    question_sensitive: "YES",
    question_type: "FAST-CHANGING",
    question_complexity: "Multi-hop",
    question_category: "Business",
    question_popularity: "Tail",
    evidence_relevant: ["YES", "YES", "YES", "YES", "NO"],
    evidence_correct: ["ANSWER-THE-QUESTION", "ANSWER-THE-QUESTION", "OUTDATED", "RELATED-INFORMATION", "UNKNOWN"],
    answer_generate: "Jane Li approved Atlas.[cite_1]",
    answer_related_info: "",
    answer_validate: "YES",
    comments: "",
    evidence_cited: ["YES", "NO", "NO", "NO", "NO"],
    question_tag: "web",
    topic_tag: "sec",
    ...overrides,
  };
}

function compact(selection) {
  return {
    citations: selection.selected.map((item) => item.citationId),
    sufficient: selection.sufficient,
    conflicts: selection.conflicts,
  };
}

test("condition A calls the real production local compiler and maps selected units back to official citations", () => {
  const { selectorView } = splitGarageRow(fixtureRow());
  const selection = selectWithProductionLocal(selectorView, { retrievalBudget: 2048, maxPassages: 6 });
  assert.equal(selection.condition, "A-production-local");
  assert.equal(selection.metrics.production.mode, "local-raw-passage-index");
  assert.ok(selection.selected.length > 0);
  const valid = new Set(selectorView.passages.map((passage) => passage.provenance.citationId));
  for (const item of selection.selected) {
    assert.ok(valid.has(item.citationId));
    assert.ok(item.selectedSegments.length > 0);
  }
});

test("condition B optimizes a set: covers the answer, avoids unrelated text and suppresses near duplicates", () => {
  const { selectorView } = splitGarageRow(fixtureRow());
  const selection = selectJudgmentEvidenceSet(selectorView, { retrievalBudget: 2048, maxPassages: 4 });
  const citations = new Set(selection.selected.map((item) => item.citationId));
  assert.equal(selection.condition, "B-judgment-set");
  assert.ok(citations.has("cite_1") || citations.has("cite_2"));
  assert.equal(citations.has("cite_5"), false);
  assert.equal(citations.has("cite_1") && citations.has("cite_2"), false, "near-duplicate answer passages should not both consume context");
  assert.equal(selection.sufficient, true);
  assert.match(selectionContext(selection), /\[EVIDENCE id=/);
});

test("B uses no judge fields: changing every gold label leaves selection byte-for-byte unchanged", () => {
  const first = splitGarageRow(fixtureRow());
  const second = splitGarageRow(fixtureRow({
    evidence_relevant: ["NO", "NO", "NO", "NO", "NO"],
    evidence_correct: ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"],
    evidence_cited: ["NO", "NO", "NO", "NO", "NO"],
    answer_generate: "A contradictory judge-only answer.",
  }));
  assert.deepEqual(first.selectorView, second.selectorView);
  assert.deepEqual(
    compact(selectJudgmentEvidenceSet(first.selectorView)),
    compact(selectJudgmentEvidenceSet(second.selectorView)),
  );
});

test("both online selectors fail closed when a nested gold field is smuggled into the view", () => {
  const { selectorView } = splitGarageRow(fixtureRow());
  const leaked = structuredClone(selectorView);
  leaked.passages[0].provenance.evidenceCorrect = "ANSWER-THE-QUESTION";
  assert.throws(() => selectWithProductionLocal(leaked), /gold\/judge field leaked/);
  assert.throws(() => selectJudgmentEvidenceSet(leaked), /gold\/judge field leaked/);
});

test("gold joins only after selection and yields class/token/deflection diagnostics, never task success", () => {
  const { selectorView, reference } = splitGarageRow(fixtureRow());
  const selection = selectJudgmentEvidenceSet(selectorView);
  const diagnostic = diagnoseGarageSelection(selectorView, reference, selection);
  assert.equal(diagnostic.diagnosticOnly, true);
  assert.equal(diagnostic.answerAvailable, true);
  assert.equal(diagnostic.classMetrics["ANSWER-THE-QUESTION"].available, 2);
  assert.ok(diagnostic.classMetrics["ANSWER-THE-QUESTION"].selected >= 1);
  assert.equal(Object.hasOwn(diagnostic, "taskSuccess"), false);
});

test("fixed stratified sampling is seed-stable and exposes a reproducible manifest", () => {
  const cases = Array.from({ length: 12 }, (_, index) => {
    const hex = (index + 1).toString(16).padStart(12, "0");
    const row = fixtureRow({ sample_id: `22222222-2222-4222-8222-${hex}` });
    if (index % 3 === 1) {
      row.evidence_correct = ["RELATED-INFORMATION", "UNKNOWN", "OUTDATED", "RELATED-INFORMATION", "UNKNOWN"];
      row.evidence_relevant = ["YES", "NO", "YES", "YES", "NO"];
      row.answer_generate = "";
    } else if (index % 3 === 2) {
      row.evidence_correct = ["UNKNOWN", "UNKNOWN", "OUTDATED", "UNKNOWN", "UNKNOWN"];
      row.evidence_relevant = ["NO", "NO", "NO", "NO", "NO"];
      row.answer_generate = "";
    }
    return splitGarageRow(row);
  });
  const left = fixedStratifiedGarageSample(cases, { seed: "fixed", size: 7 });
  const right = fixedStratifiedGarageSample(cases, { seed: "fixed", size: 7 });
  assert.deepEqual(left.map((entry) => entry.selectorView.caseKey), right.map((entry) => entry.selectorView.caseKey));
  assert.deepEqual(garageSampleManifest(left, { seed: "fixed" }), garageSampleManifest(right, { seed: "fixed" }));
});
