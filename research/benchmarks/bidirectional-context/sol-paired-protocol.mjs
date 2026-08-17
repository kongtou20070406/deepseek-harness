import { createHash } from "node:crypto";
import { MEMSYCO_TASK_SPECS, assertNoMemSycoGoldLeak } from "../memsyco/adapter.mjs";
import {
  DIAGNOSTIC_BUCKETS,
  makeMemSycoJudgeLaneToken,
  makeMemSycoPostHocPacket,
  makeMemSycoScoredResult,
  sealMemSycoOnlineResult,
} from "../memsyco/protocol.mjs";
import {
  buildMemSycoAnswerPrompt,
  buildMemSycoJudgePrompt,
  parseMemSycoJudgeResponse,
} from "../memsyco/runner-core.mjs";

export const SOL_PAIRED_CONDITIONS = Object.freeze(["raw", "bidirectional-heat"]);
export const SOL_PAIRED_LABELS = Object.freeze({ raw: "full/raw", "bidirectional-heat": "LSC-EPC production" });

export function assertSolOnlyModel(model, lane = "model") {
  const normalized = String(model || "").replace(/^openai-codex\//, "");
  if (normalized !== "gpt-5.6-sol") throw new Error(`${lane} must be gpt-5.6-sol, received ${JSON.stringify(model)}`);
  return normalized;
}

export function assertSolRunAuthorized({ authorized = false, validateOnly = false, dryRun = false } = {}) {
  if (authorized || validateOnly || dryRun) return true;
  throw new Error("Refusing Sol model calls without explicit --authorized-model-run");
}

function seedUint32(value) {
  return createHash("sha256").update(String(value)).digest().readUInt32LE(0);
}

function rng(value) {
  let state = seedUint32(value) || 0x4c534345;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function solPairedOrder(caseKey, seed, { judge = false } = {}) {
  const firstRaw = (seedUint32(`${seed}\0${caseKey}\0answer`) & 1) === 0;
  const answer = firstRaw ? [...SOL_PAIRED_CONDITIONS] : [...SOL_PAIRED_CONDITIONS].reverse();
  return judge ? [...answer].reverse() : answer;
}

export async function runSolPairedOnline({ selectorView, conditionOrder, assemblies, answer }) {
  assertNoMemSycoGoldLeak(selectorView);
  if (typeof answer !== "function") throw new Error("answer callback is required");
  const names = [...conditionOrder];
  if (names.length !== 2 || new Set(names).size !== 2 || names.some((name) => !SOL_PAIRED_CONDITIONS.includes(name))) {
    throw new Error("Sol paired online phase requires raw and bidirectional-heat exactly once");
  }
  const sealed = {};
  for (const condition of names) {
    const assembly = assemblies?.[condition];
    if (!assembly || assembly.overflow) throw new Error(`${selectorView.caseKey}/${condition} has no valid assembly`);
    const prompt = buildMemSycoAnswerPrompt(selectorView, assembly.context);
    const completion = await answer({ caseKey: selectorView.caseKey, prompt });
    const text = typeof completion === "string" ? completion : completion?.text;
    sealed[condition] = sealMemSycoOnlineResult({
      caseKey: selectorView.caseKey,
      condition,
      answer: text,
      evidenceView: assembly.evidenceView,
      contextTokens: assembly.contextTokens,
      assemblyMs: assembly.assemblyMs,
    });
  }
  return Object.freeze(sealed);
}

/** Judge each unique frozen answer+evidence outcome once. The callback receives
 * an opaque lane and a condition-free packet; the condition mapping remains in
 * this deterministic post-hoc function. */
export async function judgeSolPairedFrozen({ reference, sealedByCondition, seed, judge }) {
  if (typeof judge !== "function") throw new Error("judge callback is required");
  const groups = new Map();
  // Reverse the per-case answer order to counterbalance temporal/provider drift
  // across conditions. Identical outcomes are still collapsed into one lane.
  for (const condition of solPairedOrder(reference.caseKey, seed, { judge: true })) {
    const sealed = sealedByCondition?.[condition];
    if (!sealed?.sealed || !Object.isFrozen(sealed)) throw new Error(`Missing frozen ${condition} result`);
    const digest = hashJson({ answer: sealed.answer, evidenceView: sealed.evidenceView });
    if (!groups.has(digest)) groups.set(digest, []);
    groups.get(digest).push(condition);
  }
  const unique = [...groups.entries()];
  const parsedByCondition = new Map();
  for (let ordinal = 0; ordinal < unique.length; ordinal += 1) {
    const [, conditions] = unique[ordinal];
    const representative = sealedByCondition[conditions[0]];
    const laneToken = makeMemSycoJudgeLaneToken({ caseKey: reference.caseKey, seed, ordinal });
    // Build explicitly here so tests can assert that the packet contains no
    // experimental condition name before it crosses the model boundary.
    makeMemSycoPostHocPacket(reference, representative, { laneToken });
    const prompt = buildMemSycoJudgePrompt(reference, representative, { laneToken });
    const completion = await judge({ caseKey: reference.caseKey, laneToken, prompt });
    const text = typeof completion === "string" ? completion : completion?.text;
    const parsed = parseMemSycoJudgeResponse(text);
    for (const condition of conditions) parsedByCondition.set(condition, parsed);
  }
  return SOL_PAIRED_CONDITIONS.map((condition) => {
    const parsed = parsedByCondition.get(condition);
    return makeMemSycoScoredResult({
      reference,
      sealedResult: sealedByCondition[condition],
      answerJudge: parsed.answerJudge,
      retrievalJudge: parsed.retrievalJudge,
    });
  });
}

function conditionSummary(rows) {
  const taskScorable = rows.filter((row) => row.taskSuccess !== null);
  const answerScorable = rows.filter((row) => row.answerCorrect !== null);
  const authorityScorable = rows.filter((row) => row.authorityCorrect !== null);
  const diagnostics = Object.fromEntries(DIAGNOSTIC_BUCKETS.map((name) => [name, 0]));
  for (const row of rows) diagnostics[row.diagnostic] = (diagnostics[row.diagnostic] || 0) + 1;
  return {
    n: rows.length,
    taskScorable: taskScorable.length,
    taskSuccessRate: taskScorable.length ? taskScorable.filter((row) => row.taskSuccess).length / taskScorable.length : null,
    answerScorable: answerScorable.length,
    answerAccuracy: answerScorable.length ? answerScorable.filter((row) => row.answerCorrect).length / answerScorable.length : null,
    authorityScorable: authorityScorable.length,
    correctAuthorityUseRate: authorityScorable.length ? authorityScorable.filter((row) => row.authorityCorrect).length / authorityScorable.length : null,
    contextTokens: {
      mean: mean(rows.map((row) => row.contextTokens)),
      p50: quantile(rows.map((row) => row.contextTokens), 0.5),
      p95: quantile(rows.map((row) => row.contextTokens), 0.95),
    },
    assemblyMs: {
      mean: mean(rows.map((row) => row.assemblyMs)),
      p50: quantile(rows.map((row) => row.assemblyMs), 0.5),
      p95: quantile(rows.map((row) => row.assemblyMs), 0.95),
    },
    diagnostics,
  };
}

function pairedBootstrap(pairs, field, {
  samples = 20_000,
  confidence = 0.95,
  nonInferiorityMargin = 0.05,
  minimumSample = 60,
  seed = "sol-lsc-epc-5pct-v1",
} = {}) {
  const usable = pairs.filter((row) => row.raw[field] !== null && row["bidirectional-heat"][field] !== null);
  if (!usable.length) return {
    field, n: 0, differenceLscMinusRaw: null, confidenceInterval: [null, null],
    nonInferiorityMargin, inferenceReady: false, lscNonInferior: null,
  };
  const differences = usable.map((row) => Number(row["bidirectional-heat"][field]) - Number(row.raw[field]));
  const random = rng(`${seed}\0${field}`);
  const draws = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1) sum += differences[Math.floor(random() * differences.length)];
    draws.push(sum / differences.length);
  }
  const alpha = (1 - confidence) / 2;
  const difference = mean(differences);
  const inferenceReady = usable.length >= minimumSample;
  return {
    field,
    n: usable.length,
    differenceLscMinusRaw: difference,
    confidence,
    confidenceInterval: [quantile(draws, alpha), quantile(draws, 1 - alpha)],
    nonInferiorityMargin,
    minimumSample,
    inferenceReady,
    pointDifferenceWithinMargin: difference >= -nonInferiorityMargin,
    lscNonInferior: inferenceReady ? quantile(draws, alpha) > -nonInferiorityMargin : null,
    discordant: {
      rawOnly: usable.filter((row) => row.raw[field] && !row["bidirectional-heat"][field]).length,
      lscOnly: usable.filter((row) => !row.raw[field] && row["bidirectional-heat"][field]).length,
    },
  };
}

export function summarizeSolPaired(scoredRows, options = {}) {
  const byCase = new Map();
  for (const row of scoredRows) {
    if (!SOL_PAIRED_CONDITIONS.includes(row.condition)) throw new Error(`Unknown Sol paired condition ${row.condition}`);
    const pair = byCase.get(row.caseKey) || {};
    if (pair[row.condition]) throw new Error(`Duplicate ${row.caseKey}/${row.condition}`);
    pair[row.condition] = row;
    byCase.set(row.caseKey, pair);
  }
  const pairs = [...byCase.entries()].map(([caseKey, pair]) => {
    for (const condition of SOL_PAIRED_CONDITIONS) if (!pair[condition]) throw new Error(`${caseKey} missing ${condition}`);
    if (pair.raw.task !== pair["bidirectional-heat"].task) throw new Error(`${caseKey} task mismatch`);
    return { caseKey, task: pair.raw.task, ...pair };
  }).sort((a, b) => a.caseKey.localeCompare(b.caseKey));
  const byTask = {};
  for (const task of Object.keys(MEMSYCO_TASK_SPECS)) {
    const taskPairs = pairs.filter((pair) => pair.task === task);
    if (!taskPairs.length) continue;
    byTask[task] = {
      raw: conditionSummary(taskPairs.map((pair) => pair.raw)),
      lscEpc: conditionSummary(taskPairs.map((pair) => pair["bidirectional-heat"])),
    };
  }
  const taskSuccess = pairedBootstrap(pairs, "taskSuccess", options);
  const authorityUse = pairedBootstrap(pairs, "authorityCorrect", options);
  return {
    protocol: "memsyco-sol-raw-vs-lsc-epc-paired-v1",
    cases: pairs.length,
    raw: conditionSummary(pairs.map((pair) => pair.raw)),
    lscEpc: conditionSummary(pairs.map((pair) => pair["bidirectional-heat"])),
    pairedTaskSuccess: taskSuccess,
    pairedAuthorityUse: authorityUse,
    adoptionGate: {
      judgeComplete: pairs.every((pair) => pair.raw.taskSuccess !== null && pair["bidirectional-heat"].taskSuccess !== null),
      taskSuccessNonInferior: taskSuccess.lscNonInferior,
      authorityUseNonInferior: authorityUse.lscNonInferior,
      performanceGatePassed: taskSuccess.lscNonInferior === true && authorityUse.lscNonInferior === true,
      tokenComparisonEligible: taskSuccess.lscNonInferior === true && authorityUse.lscNonInferior === true,
    },
    regressions: pairs.filter((pair) => pair.raw.taskSuccess === true && pair["bidirectional-heat"].taskSuccess === false)
      .map((pair) => ({ caseKey: pair.caseKey, task: pair.task, lscDiagnostic: pair["bidirectional-heat"].diagnostic })),
    byTask,
  };
}
