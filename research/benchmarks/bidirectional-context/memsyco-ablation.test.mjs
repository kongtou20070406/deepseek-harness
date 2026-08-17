import assert from "node:assert/strict";
import test from "node:test";
import { splitMemSycoRow } from "../memsyco/adapter.mjs";
import { MEMSYCO_SCHEMA_FIXTURES } from "../memsyco/fixtures.mjs";
import {
  compileMemSycoAblationCase,
  memSycoHistoryMessages,
  runMemSycoAssemblyAblation,
} from "./memsyco-ablation.mjs";

const fixture = (task) => {
  const row = MEMSYCO_SCHEMA_FIXTURES.find((item) => item.task === task);
  if (!row) throw new Error(`Missing fixture for ${task}`);
  return structuredClone(row);
};

test("MemSyco adapter preserves online-only text and synthetic entry lineage", () => {
  const item = splitMemSycoRow(fixture("valid_memory_selection"));
  const messages = memSycoHistoryMessages(item.selectorView);
  assert.equal(messages.length, item.selectorView.history.length);
  assert.equal(messages[0].entryId, item.selectorView.history[0].turnId);
  assert.equal(messages[1].parentEntryId, messages[0].entryId);
  assert.equal(JSON.stringify(messages).includes("reference_answer"), false);
  assert.equal(JSON.stringify(messages).includes(item.reference.officialId), false);
});

test("assembly conditions remain verbatim, deterministic and condition-blind", () => {
  const item = splitMemSycoRow(fixture("personalized_memory_use"));
  for (const condition of ["positive-only", "gc-only", "bidirectional", "bidirectional-heat"]) {
    const first = compileMemSycoAblationCase(item, { condition, budget: 512 });
    const second = compileMemSycoAblationCase(item, { condition, budget: 512 });
    assert.equal(first.context, second.context);
    assert.equal(first.outputHash, second.outputHash);
    assert.doesNotMatch(first.context, /positive-only|gc-only|bidirectional/i);
  }
});

test("assembly-only report refuses to invent task success or false-drop rates", () => {
  const cases = [
    splitMemSycoRow(fixture("objective_fact_judgment")),
    splitMemSycoRow(fixture("memory_evidence_conflict")),
  ];
  const report = runMemSycoAssemblyAblation(cases, { conditions: ["positive-only", "bidirectional"], budgets: [256] });
  assert.equal(report.rows.length, 4);
  assert.equal(report.summary.length, 2);
  assert.equal(report.summary.every((row) => row.taskSuccess === null && row.falseDropRate === null), true);
});
