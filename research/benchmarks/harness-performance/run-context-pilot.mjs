import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkCases } from "./cases.mjs";
import { LunaBudgetLedger } from "./budget-ledger.mjs";
import { completeLuna } from "./luna-client.mjs";
import {
  compileContext,
  groupTurns,
  makeFoldUnits,
  serializeMessage,
  summaryPrompt,
} from "../../../pi-idea-extension/src/context-compiler.js";
import { estimateTokens } from "../../../pi-idea-extension/src/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(here, ".cache");
const resultsDir = join(here, "results");
await mkdir(cacheDir, { recursive: true });
await mkdir(resultsDir, { recursive: true });

const args = new Map(process.argv.slice(2).flatMap((value, index, all) => value.startsWith("--") ? [[value, all[index + 1]]] : []));
const caseLimit = Math.max(1, Math.min(8, Number(args.get("--cases") || 4)));
const concurrency = Math.max(1, Math.min(4, Number(args.get("--concurrency") || 4)));
const runId = `context-pilot-${new Date().toISOString().replace(/[:.]/g, "-")}-${caseLimit}`;
const ledger = await new LunaBudgetLedger(join(here, "luna-budget.json")).load();

function hash(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

async function cachedCall(prompt, meta, maxTokens = 600) {
  const key = hash(`${meta.condition}\n${prompt}`);
  const path = join(cacheDir, `${key}.json`);
  try {
    const cached = JSON.parse(await readFile(path, "utf8"));
    return { ...cached, cached: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const reservation = ledger.reserve({ prompt, maxTokens, runId, caseId: meta.caseId, condition: meta.condition });
  try {
    const result = await completeLuna(prompt, { maxTokens, reasoningEffort: "low", timeoutMs: 180_000 });
    const charged = await ledger.settle(reservation, result.usage);
    const saved = { ...result, charged, promptHash: hash(prompt) };
    await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
    return saved;
  } catch (error) {
    await ledger.settle(reservation, null, { failed: true, error: error.message });
    throw error;
  }
}

async function pool(items, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

function taskSuffix(item) {
  const options = Object.entries(item.options).map(([key, value]) => `${key}. ${value}`).join("\n");
  return `<task>\n${item.question}\n\n${options}\n</task>\n` +
    `只输出一行 JSON，不要解释：{"answer":"A/B/C/D","evidence":["证据ID"]}。evidence 只列真正决定答案的历史证据 ID。`;
}

function promptWith(item, condition, context) {
  return `<authoritative_idea>\n${item.p0}\n</authoritative_idea>\n` +
    `<current_stage>\n${item.stage}\n</current_stage>\n` +
    `<assembled_context condition="${condition}">\n${context}\n</assembled_context>\n` +
    taskSuffix(item);
}

function parseAnswer(text) {
  const candidate = String(text).match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return { answer: null, evidence: [], parseError: "no-json" };
  try {
    const parsed = JSON.parse(candidate);
    return {
      answer: typeof parsed.answer === "string" ? parsed.answer.trim().toUpperCase() : null,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
      parseError: null,
    };
  } catch (error) {
    return { answer: null, evidence: [], parseError: error.message };
  }
}

const cases = benchmarkCases(caseLimit);
const prepared = [];
for (const item of cases) {
  const raw = item.messages.map(serializeMessage).join("\n\n--- TURN ---\n\n");
  const turns = groupTurns(item.messages);
  const units = makeFoldUnits(turns.slice(0, -4));
  const batchedUnits = makeFoldUnits(turns.slice(0, -4), { minTokens: 4800, maxTokens: 7200 });
  prepared.push({ item, raw, turns, units, batchedUnits });
}

const summaryJobs = prepared.flatMap((entry) => [
  {
    kind: "global",
    entry,
    prompt: `把下面长任务历史压缩成一份可继续工作的派生摘要。必须保留用户决定、实验结果及限定条件、冲突、失败、权限、过期候选和未决事项，并保留所有 EVIDENCE id；删除重复工具日志。不得改变 authoritative idea。输出不超过 1000 中文字。\n\n${entry.raw}`,
  },
  ...entry.units.map((unit) => ({ kind: "unit", entry, unit, prompt: summaryPrompt(unit, `benchmark:${entry.item.id}`) })),
  ...entry.batchedUnits.map((unit) => ({ kind: "unit-batched", entry, unit, prompt: summaryPrompt(unit, `benchmark-batched:${entry.item.id}`) })),
]);

process.stdout.write(`run=${runId} cases=${caseLimit} summary_jobs=${summaryJobs.length} concurrency=${concurrency}\n`);
const summaryOutputs = await pool(summaryJobs, async (job, index) => {
  const result = await cachedCall(job.prompt, {
    caseId: job.entry.item.id,
    condition: job.kind === "global" ? "prepare-global-summary" : (job.kind === "unit-batched" ? "prepare-block-summary-batched" : "prepare-block-summary"),
  }, job.kind === "global" ? 1400 : 800);
  process.stdout.write(`prepared ${index + 1}/${summaryJobs.length} ${job.entry.item.id} ${job.kind} ${result.cached ? "cache" : result.charged.total}\n`);
  return { ...job, result };
});

for (const entry of prepared) {
  entry.globalSummary = summaryOutputs.find((output) => output.kind === "global" && output.entry === entry).result.text;
  entry.summaries = new Map(summaryOutputs
    .filter((output) => output.kind === "unit" && output.entry === entry)
    .map((output) => [output.unit.id, { summary: output.result.text, tokens: estimateTokens(output.result.text) }]));
  entry.batchedSummaries = new Map(summaryOutputs
    .filter((output) => output.kind === "unit-batched" && output.entry === entry)
    .map((output) => [output.unit.id, { summary: output.result.text, tokens: estimateTokens(output.result.text) }]));
}

const conditionJobs = prepared.flatMap((entry, caseIndex) => {
  const { item, raw } = entry;
  const tail4 = groupTurns(item.messages).slice(-4).flatMap((turn) => turn.messages).map(serializeMessage).join("\n\n");
  const tail2 = groupTurns(item.messages).slice(-2).flatMap((turn) => turn.messages).map(serializeMessage).join("\n\n");
  const compiled = compileContext({
    messages: item.messages,
    prompt: item.question,
    stage: item.stage,
    summaries: entry.summaries,
    liveTurns: 4,
    retrievalBudget: 3600,
    maxRetrievedUnits: 3,
  });
  const compiledP0 = compileContext({
    messages: item.messages,
    idea: item.p0,
    prompt: item.question,
    stage: item.stage,
    summaries: entry.summaries,
    liveTurns: 4,
    retrievalBudget: 3600,
    maxRetrievedUnits: 3,
  });
  const compiledP0Batched = compileContext({
    messages: item.messages,
    idea: item.p0,
    prompt: item.question,
    stage: item.stage,
    summaries: entry.batchedSummaries,
    liveTurns: 4,
    retrievalBudget: 3600,
    maxRetrievedUnits: 3,
    foldMinTokens: 4800,
    foldMaxTokens: 7200,
  });
  entry.compiled = compiled;
  entry.compiledP0 = compiledP0;
  entry.compiledP0Batched = compiledP0Batched;
  const contexts = {
    full_raw: raw,
    recent_tail: tail4,
    global_summary_tail: `${entry.globalSummary}\n\n<recent_raw>\n${tail2}\n</recent_raw>`,
    current_compiler: compiled.messages.map(serializeMessage).join("\n\n"),
    compiler_p0_enriched: compiledP0.messages.map(serializeMessage).join("\n\n"),
    compiler_p0_batched: compiledP0Batched.messages.map(serializeMessage).join("\n\n"),
    oracle_minimum: `${item.oracleEvidence}\n\n<recent_raw>\n${tail2}\n</recent_raw>`,
  };
  const order = Object.keys(contexts);
  const rotated = [...order.slice(caseIndex % order.length), ...order.slice(0, caseIndex % order.length)];
  return rotated.map((condition) => ({
    entry,
    condition,
    prompt: promptWith(item, condition, contexts[condition]),
    contextTokens: estimateTokens(contexts[condition]),
  }));
});

const rawResults = await pool(conditionJobs, async (job, index) => {
  const result = await cachedCall(job.prompt, { caseId: job.entry.item.id, condition: job.condition }, 300);
  const parsed = parseAnswer(result.text);
  const required = new Set(job.entry.item.requiredEvidence);
  const returned = new Set(parsed.evidence);
  const evidenceHits = [...required].filter((id) => returned.has(id)).length;
  const record = {
    caseId: job.entry.item.id,
    condition: job.condition,
    expected: job.entry.item.answer,
    answer: parsed.answer,
    correct: parsed.answer === job.entry.item.answer,
    requiredEvidence: [...required],
    evidence: [...returned],
    evidenceRecall: required.size ? evidenceHits / required.size : 1,
    evidencePrecision: returned.size ? evidenceHits / returned.size : 0,
    parseError: parsed.parseError,
    contextTokens: job.contextTokens,
    response: result.text,
    usage: result.charged,
    ms: result.ms,
    cached: Boolean(result.cached),
  };
  process.stdout.write(`evaluated ${index + 1}/${conditionJobs.length} ${record.caseId} ${record.condition} correct=${record.correct}\n`);
  return record;
});

const byCondition = {};
for (const condition of [...new Set(rawResults.map((result) => result.condition))]) {
  const rows = rawResults.filter((result) => result.condition === condition);
  byCondition[condition] = {
    cases: rows.length,
    accuracy: rows.filter((row) => row.correct).length / rows.length,
    evidenceRecall: rows.reduce((sum, row) => sum + row.evidenceRecall, 0) / rows.length,
    evidencePrecision: rows.reduce((sum, row) => sum + row.evidencePrecision, 0) / rows.length,
    meanContextTokens: Math.round(rows.reduce((sum, row) => sum + row.contextTokens, 0) / rows.length),
    meanLatencyMs: Math.round(rows.reduce((sum, row) => sum + row.ms, 0) / rows.length),
    totalUsage: rows.reduce((sum, row) => sum + row.usage.total, 0),
  };
}

const report = {
  schema: 1,
  benchmark: "pi-idea-context-performance-pilot-v1",
  runId,
  model: "openai-codex/gpt-5.6-luna",
  generatedAt: new Date().toISOString(),
  cases: caseLimit,
  conditions: byCondition,
  compiler: prepared.map((entry) => ({
    caseId: entry.item.id,
    rawTokens: entry.compiled.metrics.rawTokens,
    compiledTokens: entry.compiled.metrics.compiledTokens,
    selected: entry.compiled.selected.map((unit) => ({ id: unit.id, score: unit.score, mode: unit.injectMode, tokens: unit.summaryTokens || unit.tokens })),
    omitted: entry.compiled.omitted.length,
    p0Enriched: {
      compiledTokens: entry.compiledP0.metrics.compiledTokens,
      selected: entry.compiledP0.selected.map((unit) => ({ id: unit.id, score: unit.score, mode: unit.injectMode, tokens: unit.summaryTokens || unit.tokens })),
      omitted: entry.compiledP0.omitted.length,
    },
    p0Batched: {
      coldUnits: entry.compiledP0Batched.coldUnits.length,
      compiledTokens: entry.compiledP0Batched.metrics.compiledTokens,
      selected: entry.compiledP0Batched.selected.map((unit) => ({ id: unit.id, score: unit.score, mode: unit.injectMode, tokens: unit.summaryTokens || unit.tokens })),
      omitted: entry.compiledP0Batched.omitted.length,
    },
  })),
  results: rawResults,
  aggregateLunaBudget: ledger.ledger,
};

const reportPath = join(resultsDir, `${runId}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ reportPath: resolve(reportPath), conditions: byCondition, aggregateUsage: ledger.ledger.usage }, null, 2)}\n`);
