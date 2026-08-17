import { createHash } from "node:crypto";
import { MEMSYCO_TASK_SPECS, assertNoMemSycoGoldLeak } from "../memsyco/adapter.mjs";
import { DIAGNOSTIC_BUCKETS, makeMemSycoJudgeLaneToken, makeMemSycoScoredResult, sealMemSycoOnlineResult } from "../memsyco/protocol.mjs";
import { buildMemSycoAnswerPrompt, buildMemSycoJudgePrompt, parseMemSycoJudgeResponse } from "../memsyco/runner-core.mjs";

export const EVIDENCE_LADDER_CONDITIONS = Object.freeze(["raw", "evidence-ladder"]);

function seedUint32(value) {
  return createHash("sha256").update(String(value)).digest().readUInt32LE(0);
}

function rng(value) {
  let state = seedUint32(value) || 0x5043454c;
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
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function binomialCoefficient(n, k) {
  const m = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= m; index += 1) result = result * (n - m + index) / index;
  return result;
}

function oneSidedExactMcNemar(candidateOnly, rawOnly) {
  const n = candidateOnly + rawOnly;
  if (!n) return 1;
  let probability = 0;
  for (let successes = candidateOnly; successes <= n; successes += 1) {
    probability += binomialCoefficient(n, successes) * (0.5 ** n);
  }
  return Math.min(1, probability);
}

function pairedBootstrap(pairs, field, { samples = 20_000, confidence = 0.90, seed = "evidence-ladder-v5" } = {}) {
  const usable = pairs.filter((pair) => pair.raw[field] !== null && pair["evidence-ladder"][field] !== null);
  const differences = usable.map((pair) => Number(pair["evidence-ladder"][field]) - Number(pair.raw[field]));
  if (!differences.length) return { field, n: 0, difference: null, confidenceInterval: [null, null] };
  const random = rng(`${seed}\0${field}`);
  const draws = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1) sum += differences[Math.floor(random() * differences.length)];
    draws.push(sum / differences.length);
  }
  const alpha = (1 - confidence) / 2;
  const candidateOnly = usable.filter((pair) => !pair.raw[field] && pair["evidence-ladder"][field]).length;
  const rawOnly = usable.filter((pair) => pair.raw[field] && !pair["evidence-ladder"][field]).length;
  return {
    field,
    n: usable.length,
    difference: mean(differences),
    confidence,
    confidenceInterval: [quantile(draws, alpha), quantile(draws, 1 - alpha)],
    discordant: { candidateOnly, rawOnly },
    oneSidedExactMcNemarP: oneSidedExactMcNemar(candidateOnly, rawOnly),
  };
}

function conditionSummary(rows) {
  const taskRows = rows.filter((row) => row.taskSuccess !== null);
  const authorityRows = rows.filter((row) => row.authorityCorrect !== null);
  const diagnostics = Object.fromEntries(DIAGNOSTIC_BUCKETS.map((name) => [name, 0]));
  for (const row of rows) diagnostics[row.diagnostic] = (diagnostics[row.diagnostic] || 0) + 1;
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

export function evidenceLadderOrder(caseKey, seed, { judge = false } = {}) {
  const firstRaw = (seedUint32(`${seed}\0${caseKey}\0answer`) & 1) === 0;
  const order = firstRaw ? [...EVIDENCE_LADDER_CONDITIONS] : [...EVIDENCE_LADDER_CONDITIONS].reverse();
  return judge ? [...order].reverse() : order;
}

export async function runEvidenceLadderOnline({ selectorView, conditionOrder, assemblies, answer }) {
  assertNoMemSycoGoldLeak(selectorView);
  const sealed = {};
  for (const condition of conditionOrder) {
    const assembly = assemblies[condition];
    if (!assembly || assembly.overflow) throw new Error(`${selectorView.caseKey}/${condition} has no valid assembly`);
    const completion = await answer({ caseKey: selectorView.caseKey, prompt: buildMemSycoAnswerPrompt(selectorView, assembly.context) });
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

export async function judgeEvidenceLadderFrozen({ reference, sealedByCondition, seed, judge }) {
  const groups = new Map();
  for (const condition of evidenceLadderOrder(reference.caseKey, seed, { judge: true })) {
    const sealed = sealedByCondition[condition];
    if (!sealed?.sealed || !Object.isFrozen(sealed)) throw new Error(`Missing frozen ${condition} result`);
    const digest = hashJson({ answer: sealed.answer, evidenceView: sealed.evidenceView });
    if (!groups.has(digest)) groups.set(digest, []);
    groups.get(digest).push(condition);
  }
  const parsedByCondition = new Map();
  const unique = [...groups.values()];
  for (let ordinal = 0; ordinal < unique.length; ordinal += 1) {
    const conditions = unique[ordinal];
    const representative = sealedByCondition[conditions[0]];
    const laneToken = makeMemSycoJudgeLaneToken({ caseKey: reference.caseKey, seed, ordinal });
    const completion = await judge({ caseKey: reference.caseKey, laneToken, prompt: buildMemSycoJudgePrompt(reference, representative, { laneToken }) });
    const parsed = parseMemSycoJudgeResponse(typeof completion === "string" ? completion : completion?.text);
    for (const condition of conditions) parsedByCondition.set(condition, parsed);
  }
  return EVIDENCE_LADDER_CONDITIONS.map((condition) => makeMemSycoScoredResult({
    reference,
    sealedResult: sealedByCondition[condition],
    answerJudge: parsedByCondition.get(condition).answerJudge,
    retrievalJudge: parsedByCondition.get(condition).retrievalJudge,
  }));
}

export function summarizeEvidenceLadder(scoredRows, {
  seed = "evidence-ladder-v5",
  minimumCompression = 0.25,
  significanceAlpha = 0.10,
  authorityMargin = 0.05,
  latencyP95Ms = 100,
} = {}) {
  const byCase = new Map();
  for (const row of scoredRows) {
    const pair = byCase.get(row.caseKey) || {};
    pair[row.condition] = row;
    byCase.set(row.caseKey, pair);
  }
  const pairs = [...byCase.entries()].map(([caseKey, pair]) => {
    for (const condition of EVIDENCE_LADDER_CONDITIONS) if (!pair[condition]) throw new Error(`${caseKey} missing ${condition}`);
    return { caseKey, task: pair.raw.task, ...pair };
  }).sort((left, right) => left.caseKey.localeCompare(right.caseKey));
  const raw = conditionSummary(pairs.map((pair) => pair.raw));
  const candidate = conditionSummary(pairs.map((pair) => pair["evidence-ladder"]));
  const task = pairedBootstrap(pairs, "taskSuccess", { seed });
  const authority = pairedBootstrap(pairs, "authorityCorrect", { seed });
  const compression = raw.contextTokens.mean ? 1 - candidate.contextTokens.mean / raw.contextTokens.mean : null;
  const gate = {
    taskPointImproved: task.difference > 0,
    taskImprovementSignificant: task.oneSidedExactMcNemarP <= significanceAlpha,
    authorityNonInferior: authority.difference >= -authorityMargin && authority.discordant.rawOnly <= authority.discordant.candidateOnly,
    compressionPassed: compression >= minimumCompression,
    latencyPassed: candidate.assemblyMs.p95 <= latencyP95Ms,
  };
  gate.passed = Object.values(gate).every(Boolean);
  const byTask = {};
  for (const taskName of Object.keys(MEMSYCO_TASK_SPECS)) {
    const taskPairs = pairs.filter((pair) => pair.task === taskName);
    if (!taskPairs.length) continue;
    byTask[taskName] = {
      raw: conditionSummary(taskPairs.map((pair) => pair.raw)),
      candidate: conditionSummary(taskPairs.map((pair) => pair["evidence-ladder"])),
    };
  }
  return { cases: pairs.length, raw, candidate, pairedTask: task, pairedAuthority: authority, compression, gate, byTask };
}
