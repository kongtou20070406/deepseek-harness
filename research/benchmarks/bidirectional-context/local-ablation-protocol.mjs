import { createHash } from "node:crypto";
import { MEMSYCO_TASK_SPECS, assertNoMemSycoGoldLeak } from "../memsyco/adapter.mjs";
import {
  DIAGNOSTIC_BUCKETS,
  MEMSYCO_LOCAL_ABLATION_CONDITIONS,
  makeMemSycoJudgeLaneToken,
  makeMemSycoScoredResult,
  sealMemSycoOnlineResult,
} from "../memsyco/protocol.mjs";
import {
  buildMemSycoAnswerPrompt,
  buildMemSycoJudgePrompt,
  parseMemSycoJudgeResponse,
} from "../memsyco/runner-core.mjs";

function seedUint32(value) {
  return createHash("sha256").update(String(value)).digest().readUInt32LE(0);
}

function rng(value) {
  let state = seedUint32(value) || 0x4d535943;
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
    answerAccuracy: answerScorable.length ? answerScorable.filter((row) => row.answerCorrect).length / answerScorable.length : null,
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

function pairedBootstrap(pairs, candidate, {
  samples = 20_000,
  confidence = 0.95,
  margin = 0.10,
  minimumSample = 60,
  seed = "memsyco-local-ablation",
} = {}) {
  const usable = pairs.filter((row) => row["positive-only"].taskSuccess !== null && row[candidate].taskSuccess !== null);
  if (!usable.length) return {
    candidate,
    n: 0,
    differenceCandidateMinusPositive: null,
    confidenceInterval: [null, null],
    inferenceReady: false,
    nonInferior: null,
  };
  const differences = usable.map((row) => Number(row[candidate].taskSuccess) - Number(row["positive-only"].taskSuccess));
  const random = rng(`${seed}\0${candidate}`);
  const draws = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1) sum += differences[Math.floor(random() * differences.length)];
    draws.push(sum / differences.length);
  }
  const alpha = (1 - confidence) / 2;
  const difference = mean(differences);
  const inferenceReady = usable.length >= minimumSample;
  const lower = quantile(draws, alpha);
  const upper = quantile(draws, 1 - alpha);
  return {
    candidate,
    n: usable.length,
    differenceCandidateMinusPositive: difference,
    confidence,
    confidenceInterval: [lower, upper],
    margin,
    minimumSample,
    inferenceReady,
    pointDifferenceWithinMargin: difference >= -margin,
    nonInferior: inferenceReady ? lower > -margin : null,
  };
}

export function localAblationOrder(caseKey, seed, { judge = false } = {}) {
  const result = [...MEMSYCO_LOCAL_ABLATION_CONDITIONS];
  const random = rng(`${seed}\0${caseKey}\0${judge ? "judge" : "answer"}`);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function selectedVerbatimTurns(selectorView, compilation) {
  assertNoMemSycoGoldLeak(selectorView);
  const byTurn = new Map(selectorView.history.map((turn, historyIndex) => [turn.turnId, { turn, historyIndex }]));
  const grouped = new Map();
  for (const block of compilation.selectedBlocks) {
    const source = byTurn.get(block.provenance.entryId);
    if (!source || source.turn.role !== block.role) throw new Error(`${selectorView.caseKey} selected block has no matching online turn`);
    if (!grouped.has(block.provenance.entryId)) grouped.set(block.provenance.entryId, { source, blocks: [] });
    grouped.get(block.provenance.entryId).blocks.push(block);
  }
  return [...grouped.values()].map(({ source, blocks }) => {
    const ordered = [...blocks].sort((left, right) => left.provenance.contentIndex - right.provenance.contentIndex
      || left.charStart - right.charStart
      || left.fragmentIndex - right.fragmentIndex);
    const verbatim = ordered.map((block) => block.raw).join("");
    if (source.turn.content !== verbatim) throw new Error(`${selectorView.caseKey} selected fragments do not reconstruct one complete online turn`);
    return { source, blocks: ordered, verbatim };
  }).sort((left, right) => left.source.historyIndex - right.source.historyIndex);
}

export function neutralEvidenceFromCompilation(selectorView, compilation) {
  return selectedVerbatimTurns(selectorView, compilation).map(({ source, blocks, verbatim }) => {
    return {
      kind: "cold",
      provenance: {
        turnId: source.turn.turnId,
        historyIndex: source.historyIndex,
        role: source.turn.role,
        timestamp: source.turn.timestamp ?? null,
        sourceUnitId: `sha256:${createHash("sha256").update(blocks.map((block) => block.blockId).join("|")).digest("hex")}`,
      },
      verbatim,
    };
  });
}

export async function runLocalAblationOnline({ selectorView, conditionOrder, assemblies, answer }) {
  assertNoMemSycoGoldLeak(selectorView);
  const sealed = {};
  for (const condition of conditionOrder) {
    const assembly = assemblies[condition];
    if (!assembly || assembly.overflow) throw new Error(`${selectorView.caseKey}/${condition} has no valid assembly`);
    const prompt = buildMemSycoAnswerPrompt(selectorView, assembly.context);
    const completion = await answer({ caseKey: selectorView.caseKey, condition, prompt });
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

/** Judge each unique frozen answer+evidence outcome once. Experimental names
 * never cross the judge callback; mapping happens only after its response. */
export async function judgeLocalAblationFrozen({ reference, sealedByCondition, seed, judge }) {
  const groups = new Map();
  for (const condition of MEMSYCO_LOCAL_ABLATION_CONDITIONS) {
    const sealed = sealedByCondition[condition];
    if (!sealed?.sealed || !Object.isFrozen(sealed)) throw new Error(`Missing frozen ${condition} result`);
    const neutralDigest = hashJson({ answer: sealed.answer, evidenceView: sealed.evidenceView });
    if (!groups.has(neutralDigest)) groups.set(neutralDigest, []);
    groups.get(neutralDigest).push(condition);
  }
  const unique = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  const parsedByCondition = new Map();
  for (let ordinal = 0; ordinal < unique.length; ordinal += 1) {
    const [, conditions] = unique[ordinal];
    const representative = sealedByCondition[conditions[0]];
    const laneToken = makeMemSycoJudgeLaneToken({ caseKey: reference.caseKey, seed, ordinal });
    const prompt = buildMemSycoJudgePrompt(reference, representative, { laneToken });
    const completion = await judge({ caseKey: reference.caseKey, laneToken, prompt });
    const text = typeof completion === "string" ? completion : completion?.text;
    const parsed = parseMemSycoJudgeResponse(text);
    for (const condition of conditions) parsedByCondition.set(condition, parsed);
  }
  return MEMSYCO_LOCAL_ABLATION_CONDITIONS.map((condition) => {
    const parsed = parsedByCondition.get(condition);
    return makeMemSycoScoredResult({
      reference,
      sealedResult: sealedByCondition[condition],
      answerJudge: parsed.answerJudge,
      retrievalJudge: parsed.retrievalJudge,
    });
  });
}

export function summarizeLocalAblation(scoredRows, options = {}) {
  const byCase = new Map();
  for (const row of scoredRows) {
    if (!MEMSYCO_LOCAL_ABLATION_CONDITIONS.includes(row.condition)) throw new Error(`Unknown local ablation condition ${row.condition}`);
    const conditions = byCase.get(row.caseKey) || {};
    if (conditions[row.condition]) throw new Error(`Duplicate ${row.caseKey}/${row.condition}`);
    conditions[row.condition] = row;
    byCase.set(row.caseKey, conditions);
  }
  const pairs = [...byCase.entries()].map(([caseKey, conditions]) => {
    for (const condition of MEMSYCO_LOCAL_ABLATION_CONDITIONS) {
      if (!conditions[condition]) throw new Error(`${caseKey} missing ${condition}`);
    }
    return { caseKey, task: conditions["positive-only"].task, ...conditions };
  });
  const conditions = Object.fromEntries(MEMSYCO_LOCAL_ABLATION_CONDITIONS.map((condition) => [
    condition,
    conditionSummary(pairs.map((row) => row[condition])),
  ]));
  const comparisons = Object.fromEntries(MEMSYCO_LOCAL_ABLATION_CONDITIONS
    .filter((condition) => condition !== "positive-only")
    .map((condition) => [condition, pairedBootstrap(pairs, condition, options)]));
  const byTask = {};
  for (const task of Object.keys(MEMSYCO_TASK_SPECS)) {
    const taskPairs = pairs.filter((row) => row.task === task);
    if (!taskPairs.length) continue;
    byTask[task] = Object.fromEntries(MEMSYCO_LOCAL_ABLATION_CONDITIONS.map((condition) => [
      condition,
      conditionSummary(taskPairs.map((row) => row[condition])),
    ]));
  }
  return {
    protocol: "memsyco-five-local-assemblers-v2",
    cases: pairs.length,
    conditions,
    comparisonsToPositiveOnly: comparisons,
    byTask,
  };
}
