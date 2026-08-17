import { createHash } from "node:crypto";
import { MEMSYCO_TASK_SPECS, assertNoMemSycoGoldLeak } from "../memsyco/adapter.mjs";
import { DIAGNOSTIC_BUCKETS, makeMemSycoJudgeLaneToken, makeMemSycoScoredResult, sealMemSycoOnlineResult } from "../memsyco/protocol.mjs";
import { buildMemSycoAnswerPrompt, buildMemSycoJudgePrompt, parseMemSycoJudgeResponse } from "../memsyco/runner-core.mjs";

export const LONG_HORIZON_SOL_CONDITIONS = Object.freeze(["raw-long", "evidence-ladder"]);

function seedUint32(value) {
  return createHash("sha256").update(String(value)).digest().readUInt32LE(0);
}

function rng(value) {
  let state = seedUint32(value) || 0x4c48534f;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
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

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function longHorizonSolOrder(caseKey, seed, { judge = false } = {}) {
  const firstRaw = (seedUint32(`${seed}\0${caseKey}\0answer`) & 1) === 0;
  const order = firstRaw ? [...LONG_HORIZON_SOL_CONDITIONS] : [...LONG_HORIZON_SOL_CONDITIONS].reverse();
  return judge ? [...order].reverse() : order;
}

export async function runLongHorizonSolOnline({ selectorView, conditionOrder, assemblies, answer }) {
  assertNoMemSycoGoldLeak(selectorView);
  const names = [...conditionOrder];
  if (names.length !== 2 || new Set(names).size !== 2 || names.some((name) => !LONG_HORIZON_SOL_CONDITIONS.includes(name))) {
    throw new Error("Long-horizon Sol online phase requires raw-long and evidence-ladder exactly once");
  }
  const sealed = {};
  for (const condition of names) {
    const assembly = assemblies[condition];
    const completion = await answer({ caseKey: selectorView.caseKey, condition, prompt: buildMemSycoAnswerPrompt(selectorView, assembly.context) });
    sealed[condition] = sealMemSycoOnlineResult({
      caseKey: selectorView.caseKey,
      condition,
      answer: typeof completion === "string" ? completion : completion.text,
      evidenceView: assembly.evidenceView,
      contextTokens: assembly.contextTokens,
      assemblyMs: assembly.assemblyMs,
    });
  }
  return Object.freeze(sealed);
}

export async function judgeLongHorizonSolFrozen({ reference, sealedByCondition, seed, judge }) {
  const groups = new Map();
  for (const condition of longHorizonSolOrder(reference.caseKey, seed, { judge: true })) {
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
    const result = parseMemSycoJudgeResponse(typeof completion === "string" ? completion : completion.text);
    for (const condition of conditions) parsed.set(condition, result);
  }
  return LONG_HORIZON_SOL_CONDITIONS.map((condition) => makeMemSycoScoredResult({
    reference,
    sealedResult: sealedByCondition[condition],
    answerJudge: parsed.get(condition).answerJudge,
    retrievalJudge: parsed.get(condition).retrievalJudge,
  }));
}

function conditionSummary(rows) {
  const diagnostics = Object.fromEntries(DIAGNOSTIC_BUCKETS.map((name) => [name, 0]));
  for (const row of rows) diagnostics[row.diagnostic] = (diagnostics[row.diagnostic] || 0) + 1;
  const task = rows.filter((row) => row.taskSuccess !== null);
  const authority = rows.filter((row) => row.authorityCorrect !== null);
  return {
    n: rows.length,
    taskSuccessRate: mean(task.map((row) => Number(row.taskSuccess))),
    authorityCorrectRate: mean(authority.map((row) => Number(row.authorityCorrect))),
    contextTokens: { mean: mean(rows.map((row) => row.contextTokens)), p50: quantile(rows.map((row) => row.contextTokens), 0.5), p95: quantile(rows.map((row) => row.contextTokens), 0.95) },
    assemblyMs: { mean: mean(rows.map((row) => row.assemblyMs)), p95: quantile(rows.map((row) => row.assemblyMs), 0.95) },
    diagnostics,
  };
}

function pairedBootstrap(pairs, field, { samples = 20_000, confidence = 0.95, margin = 0.05, seed = "long-horizon-sol-5pct-v1" } = {}) {
  const usable = pairs.filter((pair) => pair["raw-long"][field] !== null && pair["evidence-ladder"][field] !== null);
  const differences = usable.map((pair) => Number(pair["evidence-ladder"][field]) - Number(pair["raw-long"][field]));
  const random = rng(`${seed}\0${field}`);
  const draws = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1) sum += differences[Math.floor(random() * differences.length)];
    draws.push(sum / differences.length);
  }
  const alpha = (1 - confidence) / 2;
  const lower = quantile(draws, alpha);
  return {
    field,
    n: usable.length,
    differenceCandidateMinusRaw: mean(differences),
    confidence,
    confidenceInterval: [lower, quantile(draws, 1 - alpha)],
    nonInferiorityMargin: margin,
    nonInferior: lower > -margin,
    discordant: {
      candidateOnly: usable.filter((pair) => !pair["raw-long"][field] && pair["evidence-ladder"][field]).length,
      rawOnly: usable.filter((pair) => pair["raw-long"][field] && !pair["evidence-ladder"][field]).length,
    },
  };
}

export function summarizeLongHorizonSol(scoredRows, options = {}) {
  const grouped = new Map();
  for (const row of scoredRows) {
    const pair = grouped.get(row.caseKey) || {};
    pair[row.condition] = row;
    grouped.set(row.caseKey, pair);
  }
  const pairs = [...grouped.entries()].map(([caseKey, pair]) => {
    for (const condition of LONG_HORIZON_SOL_CONDITIONS) if (!pair[condition]) throw new Error(`${caseKey} missing ${condition}`);
    return { caseKey, task: pair["raw-long"].task, ...pair };
  });
  const raw = conditionSummary(pairs.map((pair) => pair["raw-long"]));
  const candidate = conditionSummary(pairs.map((pair) => pair["evidence-ladder"]));
  const task = pairedBootstrap(pairs, "taskSuccess", options);
  const authority = pairedBootstrap(pairs, "authorityCorrect", options);
  const compression = 1 - candidate.contextTokens.mean / raw.contextTokens.mean;
  const gate = {
    judgeComplete: pairs.length >= 60 && pairs.every((pair) => pair["raw-long"].taskSuccess !== null && pair["evidence-ladder"].taskSuccess !== null),
    taskNonInferior: task.nonInferior,
    authorityNonInferior: authority.nonInferior,
    compressionPassed: compression >= (options.minimumCompression ?? 0.50),
    latencyPassed: candidate.assemblyMs.p95 <= (options.latencyP95Ms ?? 100),
  };
  gate.passed = Object.values(gate).every(Boolean);
  const byTask = {};
  for (const taskName of Object.keys(MEMSYCO_TASK_SPECS)) {
    const subset = pairs.filter((pair) => pair.task === taskName);
    if (subset.length) byTask[taskName] = { raw: conditionSummary(subset.map((pair) => pair["raw-long"])), candidate: conditionSummary(subset.map((pair) => pair["evidence-ladder"])) };
  }
  return { cases: pairs.length, raw, candidate, pairedTask: task, pairedAuthority: authority, compression, gate, byTask };
}
