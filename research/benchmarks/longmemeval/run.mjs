import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoLabelLeak,
  datasetProfile,
  loadLongMemEval,
  selectorViewToPiMessages,
  splitLongMemEval,
  stratifiedSample,
} from "./adapter.mjs";
import { latencySummary, lexicographicDecision, pairedAccuracy } from "./statistics.mjs";
import { LunaBudgetLedger } from "../harness-performance/budget-ledger.mjs";
import { LunaRpcClient, PiRpcClient } from "../harness-performance/luna-client.mjs";
import {
  compileContext,
  compileDualTrackContext,
  evidenceTagPrompt,
  groupTurns,
  makeFoldUnits,
  parseEvidenceTags,
  serializeMessage,
} from "../../../pi-idea-extension/src/context-compiler.js";
import { estimateTokens, sha256 } from "../../../pi-idea-extension/src/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const defaultData = join(workspace, "research", "benchmarks", "third_party", "longmemeval", "longmemeval_s_cleaned.json");
const cacheDir = join(here, ".cache");
const resultDir = join(here, "results");
await mkdir(cacheDir, { recursive: true });
await mkdir(resultDir, { recursive: true });

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const flags = new Set(process.argv.slice(2).filter((value) => value.startsWith("--") && !value.includes("=")));
const dataPath = resolve(option("data", defaultData));
const sampleCount = Math.max(1, Math.min(500, Number(option("sample", 60)) || 60));
const foldMinTokens = Math.max(1, Number(option("fold-min", 4800)) || 4800);
const foldMaxTokens = Math.max(foldMinTokens, Number(option("fold-max", 7200)) || 7200);
const retrievalBudget = Math.max(256, Number(option("retrieval-budget", 12000)) || 12000);
const tagConcurrency = Math.max(1, Math.min(64, Number(option("tag-concurrency", 6)) || 6));
const answerModel = option("answer-model", "gpt-5.6-luna");
const answerReasoning = option("answer-reasoning", "high");
const judgeModel = option("judge-model", "gpt-5.6-luna");
const judgeReasoning = option("judge-reasoning", "high");
const cutoffText = option("model-cutoff", null);
const cutoffAt = cutoffText ? Date.parse(cutoffText) : null;
if (cutoffText && !Number.isFinite(cutoffAt)) throw new Error(`Invalid --model-cutoff: ${cutoffText}`);
const validateOnly = flags.has("--validate-only");
const allowOracleSmoke = flags.has("--allow-oracle-smoke");
const includeClaims = flags.has("--include-claims");
const runId = `longmemeval-${new Date().toISOString().replace(/[:.]/g, "-")}`;

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function parseJson(text, fallback = {}) {
  try { return JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || "{}"); }
  catch { return fallback; }
}

async function cached(path, create) {
  try { return { ...(JSON.parse(await readFile(path, "utf8"))), cached: true }; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const value = await create();
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { ...value, cached: false };
}

function aggregate(rows, condition) {
  const values = rows.filter((row) => row.condition === condition);
  const assembly = latencySummary(values.map((row) => row.assemblyMs));
  const context = values.map((row) => row.contextTokens);
  const correct = values.filter((row) => row.correct).length;
  const byType = {};
  for (const row of values) {
    const entry = byType[row.questionType] || { correct: 0, total: 0 };
    entry.total += 1;
    entry.correct += Number(row.correct);
    byType[row.questionType] = entry;
  }
  for (const entry of Object.values(byType)) entry.accuracy = entry.correct / entry.total;
  return {
    questions: values.length,
    correct,
    accuracy: values.length ? correct / values.length : null,
    meanContextTokens: values.length ? context.reduce((sum, value) => sum + value, 0) / values.length : null,
    assemblyMedianMs: assembly.median,
    assemblyP95Ms: assembly.p95,
    byType,
  };
}

function answerPrompt(selectorView, context) {
  return `Answer the user's question using only the supplied historical context. Respect dates and later updates. If the history does not contain enough information, say that it is not answerable. Return a concise direct answer; do not mention retrieval or this benchmark.\n\n` +
    `<question_date>${selectorView.questionDate}</question_date>\n` +
    `<question>${selectorView.question}</question>\n` +
    `<historical_context>\n${context}\n</historical_context>`;
}

// Prompt semantics are kept compatible with the official LongMemEval evaluator.
export function judgePrompt(reference, question, hypothesis) {
  if (reference.abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${reference.answer}\n\nModel Response: ${hypothesis}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  if (reference.questionType === "single-session-preference") {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${reference.answer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (reference.questionType === "knowledge-update") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${reference.answer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
  }
  const temporal = reference.questionType === "temporal-reasoning"
    ? " In addition, do not penalize off-by-one errors for a number of days, weeks or months."
    : "";
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.${temporal}\n\nQuestion: ${question}\n\nCorrect Answer: ${reference.answer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
}

const loaded = await loadLongMemEval(dataPath).catch((error) => {
  if (error?.code === "ENOENT") {
    throw new Error(`Missing LongMemEval-S data: ${dataPath}\nRun research/benchmarks/third_party/longmemeval/download.mjs after network access recovers.`);
  }
  throw error;
});
const split = splitLongMemEval(loaded.rows);
const profile = datasetProfile(split.publicCases);
const selected = stratifiedSample(split.publicCases, sampleCount);
for (const item of selected) assertNoLabelLeak(item.selectorView, split.references.get(item.caseKey));

if (validateOnly) {
  process.stdout.write(`${JSON.stringify({ dataPath, dataSha256: loaded.sha256, bytes: loaded.bytes, profile, selected: selected.length, labelLeakChecks: selected.length }, null, 2)}\n`);
  process.exit(0);
}
if (profile.likelyOracleOnly && !allowOracleSmoke) {
  throw new Error("This file looks like LongMemEval Oracle (too few sessions). It cannot support a retrieval comparison. Use LongMemEval-S, or pass --allow-oracle-smoke only to test runner plumbing.");
}

const ledger = await new LunaBudgetLedger(join(workspace, "research", "benchmarks", "harness-performance", "luna-budget.json")).load();
const taggers = Array.from({ length: tagConcurrency }, () => new LunaRpcClient({ timeoutMs: 180_000 }));
const answerClientOptions = {
  timeoutMs: 180_000,
  model: answerModel,
  reasoningEffort: answerReasoning,
  ...(cutoffAt ? { deadlineAt: cutoffAt } : {}),
};
const judgeClientOptions = {
  timeoutMs: 180_000,
  model: judgeModel,
  reasoningEffort: judgeReasoning,
  ...(cutoffAt ? { deadlineAt: cutoffAt } : {}),
};
const laneCount = includeClaims ? 3 : 2;
const answerers = Array.from({ length: laneCount }, () => new PiRpcClient(answerClientOptions));
const judges = Array.from({ length: laneCount }, () => new PiRpcClient(judgeClientOptions));
let taggersClosed = false;

async function charged(client, prompt, { caseId, condition, maxTokens }) {
  const reservation = ledger.reserve({ prompt, maxTokens, runId, caseId, condition });
  try {
    const result = await client.complete(prompt);
    const usage = await ledger.settle(reservation, result.usage);
    return { text: result.text, ms: result.ms, firstTokenMs: result.firstTokenMs, usage };
  } catch (error) {
    await ledger.settle(reservation, null, { failed: true, error: error.message });
    throw error;
  }
}

async function indexUnit(tagger, item, unit, index, total) {
    const prompt = evidenceTagPrompt(unit, { ideaHash: "longmemeval-blind", stageHash: "long-term-memory" });
    const path = join(cacheDir, `tag-${digest(prompt)}.json`);
    const record = await cached(path, async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = await charged(tagger, prompt, { caseId: item.caseKey, condition: "background-luna-tag", maxTokens: 1000 });
        const parsed = parseEvidenceTags(result.text, unit, { ideaHash: "longmemeval-blind", stageHash: "long-term-memory" });
        if (parsed.valid) return { schema: 1, id: unit.id, claims: parsed.claims, rejected: parsed.rejected, usage: result.usage, ms: result.ms, attempts: attempt };
        process.stdout.write(`index-retry ${item.caseKey} ${index + 1}/${total} attempt=${attempt}\n`);
      }
      throw new Error(`Luna tag JSON invalid after 3 attempts for ${item.caseKey}/${unit.id}`);
    });
    // Re-validate cached labels against the current raw unit on every run.
    // This also derives new deterministic provenance fields after compiler
    // upgrades without spending Luna tokens or trusting stale cache schema.
    const normalized = parseEvidenceTags(JSON.stringify({ claims: record.claims }), unit, {
      ideaHash: "longmemeval-blind",
      stageHash: "long-term-memory",
    });
    if (!normalized.valid) throw new Error(`Cached Luna tag invalid for ${item.caseKey}/${unit.id}`);
    process.stdout.write(`index ${item.caseKey} ${index + 1}/${total} claims=${normalized.claims.length}${record.cached ? " cached" : ""}\n`);
    return { ...record, claims: normalized.claims, rejectedOnReload: normalized.rejected };
}

async function indexedSummariesBatch(prepared) {
  const summariesByCase = new Map(prepared.map(({ item }) => [item.caseKey, new Map()]));
  const tasks = prepared.flatMap(({ item, units }) => units.map((unit, index) => ({ item, unit, index, total: units.length })));
  let nextIndex = 0;
  async function worker(tagger) {
    while (true) {
      const taskIndex = nextIndex;
      nextIndex += 1;
      if (taskIndex >= tasks.length) return;
      const task = tasks[taskIndex];
      const record = await indexUnit(tagger, task.item, task.unit, task.index, task.total);
      summariesByCase.get(task.item.caseKey).set(task.unit.id, record);
    }
  }
  await Promise.all(taggers.slice(0, Math.min(taggers.length, Math.max(1, tasks.length))).map(worker));
  return summariesByCase;
}

async function modelAnswer(client, item, condition, context) {
  const prompt = answerPrompt(item.selectorView, context);
  const modelKey = digest(`${answerModel}\0${answerReasoning}\0${prompt}`);
  const path = join(cacheDir, `answer-${answerModel}-${answerReasoning}-${condition}-${modelKey}.json`);
  return cached(path, async () => {
    const result = answerModel.includes("luna")
      ? await charged(client, prompt, { caseId: item.caseKey, condition: `answer-${condition}`, maxTokens: 1000 })
      : await client.complete(prompt);
    return { text: result.text, usage: result.usage, ms: result.ms, firstTokenMs: result.firstTokenMs, responseModel: result.responseModel };
  });
}

async function judgeAnswer(client, item, condition, hypothesis) {
  const reference = split.references.get(item.caseKey);
  const prompt = judgePrompt(reference, item.selectorView.question, hypothesis);
  const modelKey = digest(`${judgeModel}\0${judgeReasoning}\0${prompt}`);
  const path = join(cacheDir, `judge-${judgeModel}-${judgeReasoning}-${condition}-${modelKey}.json`);
  const result = await cached(path, async () => {
    const completion = judgeModel.includes("luna")
      ? await charged(client, prompt, { caseId: item.caseKey, condition: `judge-${condition}`, maxTokens: 32 })
      : await client.complete(prompt);
    return { text: completion.text, usage: completion.usage, ms: completion.ms, responseModel: completion.responseModel };
  });
  return { ...result, correct: /^yes\b/i.test(String(result.text).trim()) };
}

const rows = [];
try {
  const prepared = selected.map((item) => {
    const messages = selectorViewToPiMessages(item.selectorView);
    const turns = groupTurns(messages);
    const coldTurns = turns.slice(0, Math.max(0, turns.length - 4));
    const units = makeFoldUnits(coldTurns, { minTokens: foldMinTokens, maxTokens: foldMaxTokens }).filter((unit) => unit.stable);
    return { item, messages, units };
  });
  const summariesByCase = await indexedSummariesBatch(prepared);
  for (const tagger of taggers) tagger.close();
  taggersClosed = true;
  for (let caseIndex = 0; caseIndex < prepared.length; caseIndex += 1) {
    const { item, messages, units } = prepared[caseIndex];
    const summaries = summariesByCase.get(item.caseKey);
    const options = {
      messages,
      idea: "Preserve user-confirmed facts, later updates, dates and unresolved conflicts exactly enough to answer the current task.",
      stage: "Answer the current long-term memory question without inventing missing information.",
      prompt: item.selectorView.question,
      liveTurns: 4,
      retrievalBudget,
      maxRetrievedUnits: 8,
      foldMinTokens,
      foldMaxTokens,
      tagConcurrency,
    };
    const assembly = {};
    const conditions = ["local", "luna", ...(includeClaims ? ["claims"] : [])];
    for (const condition of conditions) {
      const started = performance.now();
      const directClaims = condition === "claims"
        ? compileContext({ ...options, summaries, strictEvidenceIndex: true, localEvidenceIndex: false })
        : null;
      const dual = directClaims
        ? { compiled: directClaims, track: "luna-claims-only" }
        : compileDualTrackContext({ ...options, summaries: condition === "luna" ? summaries : new Map() });
      const assemblyMs = performance.now() - started;
      if (condition === "local" && units.length && dual.track !== "local-fallback") throw new Error(`Local path did not fall back for ${item.caseKey}`);
      if (condition === "luna" && units.length && dual.track !== "luna-enhanced") throw new Error(`Luna index was not complete for ${item.caseKey}`);
      if (condition === "claims" && units.length && directClaims.metrics?.pendingIndexCount) throw new Error(`Claims index was not complete for ${item.caseKey}`);
      const context = dual.compiled.messages.map(serializeMessage).join("\n\n");
      const compiled = dual.compiled;
      assembly[condition] = {
        context,
        track: dual.track,
        assemblyMs,
        contextTokens: estimateTokens(context),
        selectedClaimIds: (compiled.selectedClaims || []).map((claim) => claim.claimId),
        selectedPassageIds: (compiled.selectedPassages || []).map((passage) => passage.passageId),
        selectedSourceUnitIds: (compiled.selected || []).map((unit) => unit.id),
        selectedEvidenceSessionIds: [...new Set([
          ...(compiled.selectedClaims || []).map((claim) => claim.memorySessionId),
          ...(compiled.selectedPassages || []).map((passage) => passage.memorySessionId),
        ].filter(Boolean))],
      };
    }
    const order = caseIndex % 2 ? ["luna", "local"] : ["local", "luna"];
    if (includeClaims) order.push("claims");
    const pairRows = await Promise.all(order.map(async (condition, lane) => {
      const answer = await modelAnswer(answerers[lane], item, condition, assembly[condition].context);
      const evaluation = await judgeAnswer(judges[lane], item, condition, answer.text);
      const reference = split.references.get(item.caseKey);
      const row = {
        caseKey: item.caseKey,
        questionType: reference.questionType,
        question: item.selectorView.question,
        abstention: reference.abstention,
        condition,
        correct: evaluation.correct,
        hypothesis: answer.text,
        contextTrack: assembly[condition].track,
        contextTokens: assembly[condition].contextTokens,
        assemblyMs: Math.round(assembly[condition].assemblyMs * 1000) / 1000,
        answerMs: answer.ms,
        judgeMs: evaluation.ms,
        cachedAnswer: answer.cached,
        cachedJudge: evaluation.cached,
        diagnostics: {
          // These evaluation-only labels are appended after answer generation;
          // neither assembler nor answer model can observe them.
          referenceAnswer: reference.answer,
          expectedEvidenceSessionIds: reference.evidenceSessionIds || [],
          selectedEvidenceSessionIds: assembly[condition].selectedEvidenceSessionIds,
          selectedSourceUnitIds: assembly[condition].selectedSourceUnitIds,
          selectedClaimIds: assembly[condition].selectedClaimIds,
          selectedPassageIds: assembly[condition].selectedPassageIds,
        },
      };
      process.stdout.write(`run ${caseIndex + 1}/${selected.length} ${item.caseKey} ${condition} correct=${row.correct} ctx=${row.contextTokens} assemble=${row.assemblyMs}ms\n`);
      return row;
    }));
    rows.push(...pairRows);
  }

  const pairedRows = selected.map((item) => {
    const local = rows.find((row) => row.caseKey === item.caseKey && row.condition === "local");
    const luna = rows.find((row) => row.caseKey === item.caseKey && row.condition === "luna");
    return { caseKey: item.caseKey, localCorrect: local.correct, lunaCorrect: luna.correct };
  });
  const paired = pairedAccuracy(pairedRows);
  const local = aggregate(rows, "local");
  const luna = aggregate(rows, "luna");
  const decision = lexicographicDecision({ paired, local, luna });
  const report = {
    schema: 1,
    benchmark: "LongMemEval-S",
    runId,
    generatedAt: new Date().toISOString(),
    data: { path: dataPath, sha256: loaded.sha256, bytes: loaded.bytes, profile, oracleSmoke: profile.likelyOracleOnly },
    protocol: {
      sample: selected.length,
      sampleSeed: "pi-idea-public-pilot-v1",
      tagModel: "openai-codex/gpt-5.6-luna:low",
      answerModel: `openai-codex/${answerModel}:${answerReasoning}`,
      judgeModel: `openai-codex/${judgeModel}:${judgeReasoning}`,
      modelCutoff: cutoffAt ? new Date(cutoffAt).toISOString() : null,
      judgePrompt: "LongMemEval-official-compatible",
      answerLabelsVisibleToAssembler: false,
      labelLeakChecks: selected.length,
      retrievalBudget,
      foldMinTokens,
      foldMaxTokens,
      optimizationOrder: ["task-success", "injected-context", "assembly-median-and-p95"],
      nonInferiorityMarginPercentagePoints: 10,
      equivalenceMarginPercentagePoints: 2,
    },
    paired,
    conditions: { local, luna, ...(includeClaims ? { claims: aggregate(rows, "claims") } : {}) },
    lexicographicDecision: decision,
    rows,
    aggregateLunaBudget: ledger.ledger,
  };
  const path = join(resultDir, `${runId}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ path, paired, conditions: report.conditions, decision }, null, 2)}\n`);
} finally {
  if (!taggersClosed) for (const tagger of taggers) tagger.close();
  for (const answerer of answerers) answerer.close();
  for (const judge of judges) judge.close();
}
