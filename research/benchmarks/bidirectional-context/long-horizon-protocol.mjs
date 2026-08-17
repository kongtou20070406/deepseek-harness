import { createHash } from "node:crypto";
import { DIAGNOSTIC_BUCKETS, makeMemSycoJudgeLaneToken, makeMemSycoScoredResult, sealMemSycoOnlineResult } from "../memsyco/protocol.mjs";
import { buildMemSycoAnswerPrompt, buildMemSycoJudgePrompt, parseMemSycoJudgeResponse } from "../memsyco/runner-core.mjs";

export const LONG_HORIZON_CONDITIONS = Object.freeze(["raw-long", "rolling-extractive", "evidence-ladder"]);

function seedUint32(value) {
  return createHash("sha256").update(String(value)).digest().readUInt32LE(0);
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function binomialCoefficient(n, k) {
  const m = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= m; index += 1) result = result * (n - m + index) / index;
  return result;
}

function oneSidedExactMcNemar(candidateOnly, baselineOnly) {
  const n = candidateOnly + baselineOnly;
  if (!n) return 1;
  let probability = 0;
  for (let successes = candidateOnly; successes <= n; successes += 1) {
    probability += binomialCoefficient(n, successes) * (0.5 ** n);
  }
  return Math.min(1, probability);
}

function conditionSummary(rows) {
  const diagnostics = Object.fromEntries(DIAGNOSTIC_BUCKETS.map((name) => [name, 0]));
  for (const row of rows) diagnostics[row.diagnostic] = (diagnostics[row.diagnostic] || 0) + 1;
  const taskRows = rows.filter((row) => row.taskSuccess !== null);
  const authorityRows = rows.filter((row) => row.authorityCorrect !== null);
  return {
    n: rows.length,
    taskSuccessRate: mean(taskRows.map((row) => Number(row.taskSuccess))),
    authorityCorrectRate: mean(authorityRows.map((row) => Number(row.authorityCorrect))),
    contextTokens: {
      mean: mean(rows.map((row) => row.contextTokens)),
      p50: quantile(rows.map((row) => row.contextTokens), 0.5),
      p95: quantile(rows.map((row) => row.contextTokens), 0.95),
    },
    assemblyMs: {
      mean: mean(rows.map((row) => row.assemblyMs)),
      p95: quantile(rows.map((row) => row.assemblyMs), 0.95),
    },
    diagnostics,
  };
}

function compare(pairs, baseline, field) {
  const usable = pairs.filter((pair) => pair[baseline][field] !== null && pair["evidence-ladder"][field] !== null);
  const candidateOnly = usable.filter((pair) => !pair[baseline][field] && pair["evidence-ladder"][field]).length;
  const baselineOnly = usable.filter((pair) => pair[baseline][field] && !pair["evidence-ladder"][field]).length;
  return {
    field,
    baseline,
    n: usable.length,
    difference: mean(usable.map((pair) => Number(pair["evidence-ladder"][field]) - Number(pair[baseline][field]))),
    discordant: { candidateOnly, baselineOnly },
    oneSidedExactMcNemarP: oneSidedExactMcNemar(candidateOnly, baselineOnly),
  };
}

export function longHorizonOrder(caseKey, seed, { judge = false } = {}) {
  const result = [...LONG_HORIZON_CONDITIONS];
  let state = seedUint32(`${seed}\0${caseKey}\0${judge ? "judge" : "answer"}`) || 0x4c484347;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export async function runLongHorizonOnline({ selectorView, conditionOrder, assemblies, answer }) {
  const sealed = {};
  for (const condition of conditionOrder) {
    const assembly = assemblies[condition];
    if (!assembly || assembly.overflow) throw new Error(`${selectorView.caseKey}/${condition} has no valid assembly`);
    const completion = await answer({ caseKey: selectorView.caseKey, condition, prompt: buildMemSycoAnswerPrompt(selectorView, assembly.context) });
    sealed[condition] = sealMemSycoOnlineResult({
      caseKey: selectorView.caseKey,
      condition,
      answer: typeof completion === "string" ? completion : completion?.text,
      evidenceView: assembly.evidenceView,
      contextTokens: assembly.contextTokens,
      assemblyMs: assembly.assemblyMs,
    });
  }
  return Object.freeze(sealed);
}

export async function judgeLongHorizonFrozen({ reference, sealedByCondition, seed, judge }) {
  const groups = new Map();
  for (const condition of longHorizonOrder(reference.caseKey, seed, { judge: true })) {
    const sealed = sealedByCondition[condition];
    if (!sealed?.sealed || !Object.isFrozen(sealed)) throw new Error(`Missing frozen ${condition} result`);
    const digest = hashJson({ answer: sealed.answer, evidenceView: sealed.evidenceView });
    if (!groups.has(digest)) groups.set(digest, []);
    groups.get(digest).push(condition);
  }
  const parsed = new Map();
  let ordinal = 0;
  for (const conditions of groups.values()) {
    const representative = sealedByCondition[conditions[0]];
    const laneToken = makeMemSycoJudgeLaneToken({ caseKey: reference.caseKey, seed, ordinal });
    ordinal += 1;
    const completion = await judge({ caseKey: reference.caseKey, laneToken, prompt: buildMemSycoJudgePrompt(reference, representative, { laneToken }) });
    const result = parseMemSycoJudgeResponse(typeof completion === "string" ? completion : completion?.text);
    for (const condition of conditions) parsed.set(condition, result);
  }
  return LONG_HORIZON_CONDITIONS.map((condition) => makeMemSycoScoredResult({
    reference,
    sealedResult: sealedByCondition[condition],
    answerJudge: parsed.get(condition).answerJudge,
    retrievalJudge: parsed.get(condition).retrievalJudge,
  }));
}

export function summarizeLongHorizon(scoredRows, {
  significanceAlpha = 0.10,
  nonInferiorityMargin = 0.05,
  minimumCompression = 0.50,
  latencyP95Ms = 100,
} = {}) {
  const byCase = new Map();
  for (const row of scoredRows) {
    const triple = byCase.get(row.caseKey) || {};
    triple[row.condition] = row;
    byCase.set(row.caseKey, triple);
  }
  const pairs = [...byCase.entries()].map(([caseKey, triple]) => {
    for (const condition of LONG_HORIZON_CONDITIONS) if (!triple[condition]) throw new Error(`${caseKey} missing ${condition}`);
    return { caseKey, ...triple };
  });
  const conditions = Object.fromEntries(LONG_HORIZON_CONDITIONS.map((condition) => [
    condition,
    conditionSummary(pairs.map((pair) => pair[condition])),
  ]));
  const taskVsRolling = compare(pairs, "rolling-extractive", "taskSuccess");
  const taskVsRaw = compare(pairs, "raw-long", "taskSuccess");
  const authorityVsRolling = compare(pairs, "rolling-extractive", "authorityCorrect");
  const authorityVsRaw = compare(pairs, "raw-long", "authorityCorrect");
  const compression = 1 - conditions["evidence-ladder"].contextTokens.mean / conditions["raw-long"].contextTokens.mean;
  const gate = {
    taskBeatsRolling: taskVsRolling.difference > 0 && taskVsRolling.oneSidedExactMcNemarP <= significanceAlpha,
    taskNonInferiorToRaw: taskVsRaw.difference >= -nonInferiorityMargin
      && taskVsRaw.discordant.baselineOnly <= taskVsRaw.discordant.candidateOnly,
    authorityNonInferiorToRaw: authorityVsRaw.difference >= -nonInferiorityMargin
      && authorityVsRaw.discordant.baselineOnly <= authorityVsRaw.discordant.candidateOnly,
    authorityNonInferiorToRolling: authorityVsRolling.difference >= -nonInferiorityMargin,
    compressionPassed: compression >= minimumCompression,
    latencyPassed: conditions["evidence-ladder"].assemblyMs.p95 <= latencyP95Ms,
  };
  gate.passed = Object.values(gate).every(Boolean);
  return { cases: pairs.length, conditions, taskVsRolling, taskVsRaw, authorityVsRolling, authorityVsRaw, compression, gate };
}
