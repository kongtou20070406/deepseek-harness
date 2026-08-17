import test from "node:test";
import assert from "node:assert/strict";
import { splitMemSycoRow } from "./adapter.mjs";
import { MEMSYCO_SCHEMA_FIXTURES } from "./fixtures.mjs";
import {
  RunLunaBudgetGate,
  assertLunaOnlyModel,
  buildNeutralMemSycoEvidenceView,
  buildMemSycoAnswerPrompt,
  buildMemSycoJudgePrompt,
  judgeFrozenMemSycoPair,
  memSycoConditionOrder,
  memSycoJudgeCacheIdentity,
  parseMemSycoJudgeResponse,
  parseMemSycoRunnerArgs,
  runMemSycoOnlinePair,
  sampleMemSycoByTask,
} from "./runner-core.mjs";
import { assertMemSycoJudgePacketBlind, makeMemSycoJudgeLaneToken } from "./protocol.mjs";

function splitFixtures() {
  return MEMSYCO_SCHEMA_FIXTURES.map(splitMemSycoRow);
}

test("seeded sampling is stable, stratified and independent of input order", () => {
  const cases = [...splitFixtures(), ...splitFixtures().map((item, index) => ({
    selectorView: { ...item.selectorView, caseKey: `${item.selectorView.caseKey}-copy-${index}` },
    reference: { ...item.reference, caseKey: `${item.reference.caseKey}-copy-${index}` },
  }))];
  const first = sampleMemSycoByTask(cases, { perTask: 1, seed: "fixed-seed" });
  const second = sampleMemSycoByTask([...cases].reverse(), { perTask: 1, seed: "fixed-seed" });
  assert.deepEqual(first.map((item) => item.selectorView.caseKey), second.map((item) => item.selectorView.caseKey));
  assert.equal(first.length, 5);
  assert.deepEqual(new Set(first.map((item) => item.reference.task)), new Set(MEMSYCO_SCHEMA_FIXTURES.map((row) => row.task)));
});

test("CLI parser supports reproducible pilot controls and rejects non-Luna models", () => {
  const parsed = parseMemSycoRunnerArgs([
    "--seed=abc", "--per-task=3", "--dry-run", "--max-luna-tokens=123456",
    "--answer-model=gpt-5.6-luna", "--answer-reasoning=low", "--retrieval-budget=2048",
  ]);
  assert.equal(parsed.seed, "abc");
  assert.equal(parsed.perTask, 3);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.maxLunaTokens, 123456);
  assert.equal(parsed.retrievalBudget, 2048);
  assert.equal(assertLunaOnlyModel("gpt-5.6-luna", "answer"), "gpt-5.6-luna");
  assert.throws(() => assertLunaOnlyModel("gpt-5.6-sol", "answer"), /Luna-only/);
  assert.throws(() => assertLunaOnlyModel("other-model", "judge"), /Luna-only/);
});

test("condition order is stable per case and judge order is reversed", () => {
  const answerOrder = memSycoConditionOrder("msy:case-a", "seed-a");
  const judgeOrder = memSycoConditionOrder("msy:case-a", "seed-a", { judge: true });
  assert.deepEqual(new Set(answerOrder), new Set(["local", "luna"]));
  assert.deepEqual(judgeOrder, [...answerOrder].reverse());
  assert.deepEqual(memSycoConditionOrder("msy:case-a", "seed-a"), answerOrder);
});

test("judge cache and budget identities expose only the opaque lane", () => {
  const laneToken = makeMemSycoJudgeLaneToken({ caseKey: "msy:cache-case", seed: "cache-seed", ordinal: 0 });
  const identity = memSycoJudgeCacheIdentity({
    laneToken,
    model: "gpt-5.6-luna",
    reasoning: "high",
    prompt: "neutral prompt",
  });
  assert.match(identity.filename, new RegExp(`^judge-v2-${laneToken}-[0-9a-f]{64}\\.json$`));
  assert.equal(identity.budgetLane, `judge-${laneToken}`);
  assert.doesNotMatch(`${identity.filename}\n${identity.budgetLane}`, /\b(?:local|luna|track)\b|local_evidence|assembled_evidence/i);
});

test("online pair sees no gold, produces frozen results, and judge starts only afterward", async () => {
  const { selectorView, reference } = splitMemSycoRow(MEMSYCO_SCHEMA_FIXTURES[2]);
  const events = [];
  const seenPrompts = [];
  const pair = await runMemSycoOnlinePair({
    selectorView,
    conditions: ["local", "luna"],
    assemble: async ({ selectorView: online, condition }) => {
      events.push(`assemble:${condition}`);
      assert.equal(JSON.stringify(online).includes(reference.officialId), false);
      assert.equal(Object.hasOwn(online, "task"), false);
      return {
        context: online.history.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
        evidenceView: online.history.map(({ turnId, role, content }, historyIndex) => ({
          kind: "active",
          provenance: { turnId, historyIndex, role, timestamp: null, sourceUnitId: null },
          verbatim: content,
        })),
        contextTokens: 99,
        assemblyMs: 1.5,
        track: condition,
      };
    },
    answer: async ({ condition, prompt }) => {
      events.push(`answer:${condition}`);
      seenPrompts.push(prompt);
      assert.equal(prompt.includes("reference_answer"), false);
      assert.equal(prompt.includes(reference.officialId), false);
      assert.equal(prompt.includes(reference.task), false);
      return { text: "Choose Boreal because the test preserved all required figures." };
    },
  });
  assert.deepEqual(Object.keys(pair).sort(), ["local", "luna"]);
  assert.equal(Object.isFrozen(pair.local), true);
  assert.equal(Object.isFrozen(pair.luna), true);
  assert.equal(seenPrompts.length, 2);
  events.push("persist-frozen");

  const judgeSeen = [];
  const scored = await judgeFrozenMemSycoPair({
    reference,
    sealedByCondition: pair,
    seed: "blind-runner-test",
    judge: async ({ laneToken, prompt }) => {
      events.push(`judge:${laneToken}`);
      judgeSeen.push({ laneToken, prompt });
      assert.match(prompt, /post-hoc-evaluation/);
      assert.match(prompt, /reference_answer/);
      // This fixture's natural text contains none of the forbidden lane words,
      // so a whole-prompt check catches structural leakage directly.
      assert.doesNotMatch(prompt, /\b(?:local|luna|track)\b|local_evidence|assembled_evidence/i);
      const packet = JSON.parse(prompt.split("\n").at(-1));
      assert.equal(assertMemSycoJudgePacketBlind(packet), true);
      assert.equal(packet.condition, undefined);
      return JSON.stringify({ accuracy: true, evidence_pass: true, misled_by_conflicting_memory: false, retrieval_sufficient: true });
    },
  });
  assert.equal(scored.length, 2);
  assert.equal(scored.every((row) => row.answerCorrect), true);
  assert.equal(scored.every((row) => row.taskSuccess), true);
  assert.equal(judgeSeen.length, 2);
  assert.equal(new Set(judgeSeen.map((item) => item.laneToken)).size, 2);
  assert.equal(events.indexOf("persist-frozen") < events.findIndex((event) => event.startsWith("judge:lane_")), true);
});

test("answer prompt is online-only while judge prompt is explicitly post-hoc", () => {
  const { selectorView, reference } = splitMemSycoRow(MEMSYCO_SCHEMA_FIXTURES[3]);
  const answerPrompt = buildMemSycoAnswerPrompt(selectorView, "user: old\nuser: new");
  assert.match(answerPrompt, /current user request/);
  assert.equal(answerPrompt.includes(reference.officialId), false);
  assert.equal(answerPrompt.includes("memoryPolicy"), false);

  const pairPromise = runMemSycoOnlinePair({
    selectorView,
    assemble: async ({ condition }) => ({
      context: "user: old\nuser: new",
      evidenceView: selectorView.history.map(({ turnId, role, content }, historyIndex) => ({
        kind: "active",
        provenance: { turnId, historyIndex, role, timestamp: null, sourceUnitId: null },
        verbatim: content,
      })),
      contextTokens: 4,
      assemblyMs: 0,
      track: condition,
    }),
    answer: async () => ({ text: "Use reproducible accuracy." }),
  });
  return pairPromise.then((pair) => {
    const laneToken = makeMemSycoJudgeLaneToken({ caseKey: reference.caseKey, seed: "prompt-test", ordinal: 0 });
    const prompt = buildMemSycoJudgePrompt(reference, pair.local, { laneToken });
    assert.match(prompt, /post-hoc-evaluation/);
    assert.match(prompt, /outdated_memory_used/);
    assert.match(prompt, /Use reproducible accuracy/);
    assert.doesNotMatch(prompt, /\b(?:local|luna|track)\b|local_evidence|assembled_evidence/i);
  });
});

test("neutral evidence view contains selected cold quotes plus active turns without compiler wrappers", () => {
  const { selectorView } = splitMemSycoRow(MEMSYCO_SCHEMA_FIXTURES[2]);
  const sourceMessages = selectorView.history.map(({ role, content }) => ({ role, content }));
  const coldUnit = {
    id: "sha256:cold-unit",
    messages: sourceMessages.slice(0, 2),
  };
  const coldQuote = `${sourceMessages[1].role.toUpperCase()}\n${sourceMessages[1].content}`;
  const compiled = {
    coldUnits: [coldUnit],
    selectedClaims: [{ sourceUnitId: coldUnit.id, quote: coldQuote }],
    selectedPassages: [{ sourceUnitId: coldUnit.id, messageKey: `${coldUnit.id}:1`, quote: coldQuote, unit: coldUnit }],
    messages: [
      { role: "custom", customType: "idea-local-evidence-v1", content: "<local_evidence_index>do not expose</local_evidence_index>" },
      ...sourceMessages.slice(2),
    ],
  };
  const view = buildNeutralMemSycoEvidenceView({ selectorView, sourceMessages, compiled });
  assert.equal(view.filter((entry) => entry.kind === "cold").length, 1, "duplicate claim/passage quote is deduplicated");
  assert.equal(view.filter((entry) => entry.kind === "active").length, sourceMessages.length - 2);
  assert.equal(view[0].provenance.turnId, selectorView.history[1].turnId);
  assert.equal(view[0].provenance.role, selectorView.history[1].role);
  assert.equal(view[0].provenance.timestamp, null);
  assert.equal(view[0].verbatim, coldQuote);
  assert.doesNotMatch(JSON.stringify(view), /local_evidence_index|assembled_evidence/i);
});

test("judge parser extracts one JSON object and marks malformed output unscorable", () => {
  const parsed = parseMemSycoJudgeResponse("```json\n{\"answer_accuracy\":true,\"memory_use_pass\":true,\"retrieval_sufficient\":true}\n```");
  assert.equal(parsed.answerJudge.answer_accuracy, true);
  assert.equal(parsed.retrievalJudge.sufficient, true);
  assert.equal(parsed.retrievalJudge.parseOk, true);
  const bad = parseMemSycoJudgeResponse("not json");
  assert.deepEqual(bad.answerJudge, {});
  assert.equal(bad.retrievalJudge.parseOk, false);
});

test("per-run Luna gate refuses a conservative reservation before touching the global ledger", async () => {
  const calls = [];
  const fakeLedger = {
    reserve(input) { calls.push(["reserve", input]); return { id: 1, amount: 80, ...input }; },
    async settle(reservation, usage, options) { calls.push(["settle", reservation, usage, options]); return { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 }; },
  };
  const gate = new RunLunaBudgetGate({ ledger: fakeLedger, maxTotal: 100, reservationEstimator: () => 80 });
  const reservation = gate.reserve({ prompt: "a", maxTokens: 1, runId: "r", caseId: "c", condition: "answer-local" });
  assert.equal(gate.snapshot().reserved, 80);
  assert.throws(() => gate.reserve({ prompt: "b", maxTokens: 1, runId: "r", caseId: "c", condition: "answer-luna" }), /per-run Luna budget/);
  assert.equal(calls.filter(([kind]) => kind === "reserve").length, 1);
  await gate.settle(reservation, { input: 10, output: 2 });
  assert.deepEqual(gate.snapshot(), { maxTotal: 100, charged: 12, reserved: 0, calls: 1, failedCalls: 0 });
});
