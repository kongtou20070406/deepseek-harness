import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { LunaBudgetLedger } from "../harness-performance/budget-ledger.mjs";
import { PiRpcClient } from "../harness-performance/luna-client.mjs";
import {
  RunLunaBudgetGate,
  assertLunaOnlyModel,
  memSycoJudgeCacheIdentity,
  sampleMemSycoByTaskPercent,
} from "../memsyco/runner-core.mjs";
import { MEMSYCO_LOCAL_ABLATION_CONDITIONS } from "../memsyco/protocol.mjs";
import { compileBidirectionalContext } from "./compiler.mjs";
import { memSycoHistoryMessages } from "./memsyco-ablation.mjs";
import {
  judgeLocalAblationFrozen,
  localAblationOrder,
  neutralEvidenceFromCompilation,
  runLocalAblationOnline,
  summarizeLocalAblation,
} from "./local-ablation-protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = new Map();
  const flags = new Set();
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${JSON.stringify(argument)}`);
    const split = argument.indexOf("=");
    if (split < 0) flags.add(argument.slice(2));
    else values.set(argument.slice(2, split), argument.slice(split + 1));
  }
  const valueNames = new Set([
    "seed", "sample-percent", "budget", "max-luna-tokens", "answer-model", "answer-reasoning",
    "judge-model", "judge-reasoning", "answer-max-tokens", "judge-max-tokens", "timeout-ms",
    "data", "cache", "results", "output", "ledger", "exclude-run",
  ]);
  const flagNames = new Set(["dry-run", "validate-only", "no-cache", "authorized-model-run"]);
  for (const name of values.keys()) if (!valueNames.has(name)) throw new Error(`Unknown option --${name}`);
  for (const name of flags) if (!flagNames.has(name)) throw new Error(`Unknown flag --${name}`);
  const integer = (name, fallback, min, max = Number.MAX_SAFE_INTEGER) => {
    const value = values.has(name) ? Number(values.get(name)) : fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${name} must be in [${min},${max}]`);
    return value;
  };
  const string = (name, fallback) => values.has(name) ? String(values.get(name)).trim() : fallback;
  const result = {
    seed: string("seed", "memsyco-five-local-5pct-v1"),
    samplePercent: integer("sample-percent", 5, 5, 5),
    budget: integer("budget", 8192, 128),
    maxLunaTokens: integer("max-luna-tokens", 10_000_000, 1),
    answerModel: string("answer-model", "gpt-5.6-luna"),
    answerReasoning: string("answer-reasoning", "low"),
    judgeModel: string("judge-model", "gpt-5.6-luna"),
    judgeReasoning: string("judge-reasoning", "low"),
    answerMaxTokens: integer("answer-max-tokens", 1000, 1),
    judgeMaxTokens: integer("judge-max-tokens", 600, 1),
    timeoutMs: integer("timeout-ms", 180_000, 1000),
    data: string("data", null),
    cache: string("cache", null),
    results: string("results", null),
    output: string("output", null),
    ledger: string("ledger", null),
    excludeRun: string("exclude-run", null),
    dryRun: flags.has("dry-run"),
    validateOnly: flags.has("validate-only"),
    noCache: flags.has("no-cache"),
    authorizedModelRun: flags.has("authorized-model-run"),
  };
  assertLunaOnlyModel(result.answerModel, "answer model");
  assertLunaOnlyModel(result.judgeModel, "judge model");
  return Object.freeze(result);
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

const options = parseArgs();
const dataPath = resolve(options.data || join(workspace, "research", "benchmarks", "third_party", "memsyco"));
const cacheDir = resolve(options.cache || join(here, ".cache-task-success"));
const resultDir = resolve(options.results || join(here, "results"));
const ledgerPath = resolve(options.ledger || join(workspace, "research", "benchmarks", "harness-performance", "luna-budget.json"));
const runId = `memsyco-five-local-5pct-${new Date().toISOString().replace(/[:.]/g, "-")}-${digest(options.seed).slice(0, 8)}`;
await mkdir(cacheDir, { recursive: true });
await mkdir(resultDir, { recursive: true });

async function cached(path, create, { validate = () => true } = {}) {
  if (!options.noCache) {
    try {
      const existing = JSON.parse(await readFile(path, "utf8"));
      if (validate(existing)) return { ...existing, cached: true };
    }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const value = await create();
  if (!validate(value)) throw new Error(`Refusing invalid cache value for ${path}`);
  await atomicJson(path, value);
  return { ...value, cached: false };
}

function validAnswerCompletion(value) {
  return typeof value?.text === "string"
    && Boolean(value.text.trim())
    && value.stopReason !== "error"
    && value.stopReason !== "aborted";
}

function assemble(item, condition) {
  const result = compileBidirectionalContext({
    messages: memSycoHistoryMessages(item.selectorView),
    query: item.selectorView.question,
    condition,
    budget: options.budget,
    liveBlocks: 1,
  });
  if (result.overflow) return result;
  return {
    overflow: false,
    context: result.context,
    contextTokens: result.contextTokens,
    assemblyMs: Math.round(result.assemblyMs * 1000) / 1000,
    evidenceView: neutralEvidenceFromCompilation(item.selectorView, result),
    outputHash: result.manifest.outputHash,
  };
}

const loaded = await loadMemSycoBench(dataPath);
let exclusion = { source: null, caseKeys: [] };
if (options.excludeRun) {
  const source = resolve(options.excludeRun);
  const prior = JSON.parse(await readFile(source, "utf8"));
  if (prior?.data?.sha256 !== loaded.sha256) throw new Error("Exclusion run dataset digest does not match the current official release");
  const caseKeys = [...new Set((prior.execution || []).map((row) => row.caseKey))];
  if (!caseKeys.length) throw new Error("Exclusion run contains no execution case keys");
  exclusion = { source, caseKeys };
}
const excludedKeys = new Set(exclusion.caseKeys);
const eligibleCases = loaded.cases.filter((item) => !excludedKeys.has(item.selectorView.caseKey));
const selected = sampleMemSycoByTaskPercent(eligibleCases, { percent: options.samplePercent, seed: options.seed });
if (selected.some((item) => excludedKeys.has(item.selectorView.caseKey))) throw new Error("Development/holdout overlap detected");
const prepared = selected.map((item) => ({
  item,
  assemblies: Object.fromEntries(MEMSYCO_LOCAL_ABLATION_CONDITIONS.map((condition) => [condition, assemble(item, condition)])),
}));
const overflow = prepared.flatMap(({ item, assemblies }) => MEMSYCO_LOCAL_ABLATION_CONDITIONS
  .filter((condition) => assemblies[condition].overflow)
  .map((condition) => ({ caseKey: item.selectorView.caseKey, condition, manifest: assemblies[condition].manifest })));
const validation = {
  benchmark: "MemSyco-Bench",
  datasetSha256: loaded.sha256,
  schemaVersion: loaded.schemaVersion,
  seed: options.seed,
  samplePercent: options.samplePercent,
  sample: prepared.length,
  budget: options.budget,
  conditions: MEMSYCO_LOCAL_ABLATION_CONDITIONS,
  assembler: "deterministic-local-only",
  LunaParticipatesInAssembly: false,
  exclusion: { source: exclusion.source, count: exclusion.caseKeys.length, overlap: 0 },
  overflow,
};

if (options.validateOnly) {
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
  process.exit(overflow.length ? 1 : 0);
}

if (options.dryRun) {
  const cases = prepared.map(({ item, assemblies }) => ({
    caseKey: item.selectorView.caseKey,
    task: item.reference.task,
    answerOrder: localAblationOrder(item.selectorView.caseKey, options.seed),
    conditions: Object.fromEntries(MEMSYCO_LOCAL_ABLATION_CONDITIONS.map((condition) => [condition, {
      overflow: assemblies[condition].overflow,
      contextTokens: assemblies[condition].contextTokens ?? null,
      assemblyMs: assemblies[condition].assemblyMs,
      outputHash: assemblies[condition].outputHash ?? null,
      evidenceCount: assemblies[condition].evidenceView?.length ?? 0,
    }])),
    uniqueContexts: new Set(MEMSYCO_LOCAL_ABLATION_CONDITIONS.map((condition) => assemblies[condition].outputHash)).size,
  }));
  process.stdout.write(`${JSON.stringify({ ...validation, dryRun: true, modelCalls: 0, cases }, null, 2)}\n`);
  process.exit(overflow.length ? 1 : 0);
}

if (overflow.length) throw new Error(`Refusing paid run: ${overflow.length} assemblies overflow the hard budget`);
if (!options.authorizedModelRun) {
  throw new Error("Refusing model-backed benchmark without the explicit --authorized-model-run flag");
}

const ledger = await new LunaBudgetLedger(ledgerPath).load();
const budget = new RunLunaBudgetGate({ ledger, maxTotal: options.maxLunaTokens });
const answerClient = new PiRpcClient({ timeoutMs: options.timeoutMs, model: options.answerModel, reasoningEffort: options.answerReasoning });
const judgeClient = new PiRpcClient({ timeoutMs: options.timeoutMs, model: options.judgeModel, reasoningEffort: options.judgeReasoning });
const frozenDir = join(resultDir, `${runId}-frozen-online`);
await mkdir(frozenDir, { recursive: true });

async function charged(client, prompt, { caseId, condition, maxTokens }) {
  const reservation = budget.reserve({ prompt, maxTokens, runId, caseId, condition });
  let settled = false;
  try {
    const completion = await client.complete(prompt);
    if (!validAnswerCompletion(completion)) {
      await budget.settle(reservation, completion.usage, {
        failed: true,
        error: `invalid completion stopReason=${completion.stopReason || "unknown"}: ${completion.errorMessage || "no provider detail"}`,
      });
      settled = true;
      throw new Error(`Invalid ${client.model} completion: ${completion.stopReason || "empty-text"}: ${completion.errorMessage || "no provider detail"}`);
    }
    const usage = await budget.settle(reservation, completion.usage);
    settled = true;
    return { ...completion, usage };
  } catch (error) {
    if (!settled) await budget.settle(reservation, null, { failed: true, error: error.message });
    throw error;
  }
}

async function completeAnswerWithOneRetry({ caseKey, prompt }) {
  const promptDigest = digest(`${options.answerModel}\0${options.answerReasoning}\0${prompt}`);
  const path = join(cacheDir, `answer-v3-${promptDigest}.json`);
  return cached(path, async () => {
    let firstError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await charged(answerClient, prompt, {
          caseId: caseKey,
          condition: `answer-${promptDigest.slice(0, 16)}-attempt-${attempt}`,
          maxTokens: options.answerMaxTokens,
        });
      } catch (error) {
        firstError ||= error;
        if (attempt === 2) throw new AggregateError([firstError, error], `Answer failed after one bounded retry for ${caseKey}`);
      }
    }
    throw firstError;
  }, { validate: validAnswerCompletion });
}

const scoredRows = [];
const onlineRows = [];
const execution = [];
try {
  for (let caseIndex = 0; caseIndex < prepared.length; caseIndex += 1) {
    const { item, assemblies } = prepared[caseIndex];
    const answerOrder = localAblationOrder(item.selectorView.caseKey, options.seed);
    const sealed = await runLocalAblationOnline({
      selectorView: item.selectorView,
      conditionOrder: answerOrder,
      assemblies,
      answer: async ({ caseKey, prompt }) => completeAnswerWithOneRetry({ caseKey, prompt }),
    });
    const frozenPath = join(frozenDir, `${item.selectorView.caseKey.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
    await atomicJson(frozenPath, { caseKey: item.selectorView.caseKey, answerOrder, sealed });
    for (const condition of MEMSYCO_LOCAL_ABLATION_CONDITIONS) {
      onlineRows.push({
        caseKey: item.selectorView.caseKey,
        condition,
        onlineDigest: sealed[condition].onlineDigest,
        contextTokens: sealed[condition].contextTokens,
        assemblyMs: sealed[condition].assemblyMs,
        answerHash: digest(sealed[condition].answer),
        evidenceCount: sealed[condition].evidenceView.length,
      });
    }
    const scored = await judgeLocalAblationFrozen({
      reference: item.reference,
      sealedByCondition: sealed,
      seed: options.seed,
      judge: async ({ caseKey, laneToken, prompt }) => {
        const identity = memSycoJudgeCacheIdentity({
          laneToken,
          model: options.judgeModel,
          reasoning: options.judgeReasoning,
          prompt,
        });
        return cached(join(cacheDir, identity.filename), async () => charged(judgeClient, prompt, {
          caseId: caseKey,
          condition: identity.budgetLane,
          maxTokens: options.judgeMaxTokens,
        }));
      },
    });
    scoredRows.push(...scored);
    execution.push({
      caseKey: item.selectorView.caseKey,
      task: item.reference.task,
      answerOrder,
      uniqueContexts: new Set(MEMSYCO_LOCAL_ABLATION_CONDITIONS.map((condition) => assemblies[condition].outputHash)).size,
      uniqueFrozenOutcomes: new Set(MEMSYCO_LOCAL_ABLATION_CONDITIONS.map((condition) => digest(JSON.stringify({
        answer: sealed[condition].answer,
        evidenceView: sealed[condition].evidenceView,
      })))).size,
      frozenPath,
    });
    process.stdout.write(`run ${caseIndex + 1}/${prepared.length} ${item.selectorView.caseKey} unique=${execution.at(-1).uniqueFrozenOutcomes}\n`);
  }
  const summary = summarizeLocalAblation(scoredRows, {
    minimumSample: 60,
    margin: 0.10,
    seed: options.seed,
  });
  const report = {
    schema: 1,
    benchmark: "MemSyco-Bench",
    runId,
    generatedAt: new Date().toISOString(),
    data: { path: dataPath, sha256: loaded.sha256, schemaVersion: loaded.schemaVersion, counts: loaded.counts },
    protocol: {
      seed: options.seed,
      samplePercent: options.samplePercent,
      sample: prepared.length,
      conditions: MEMSYCO_LOCAL_ABLATION_CONDITIONS,
      assemblyUsesModel: false,
      assemblyUsesLuna: false,
      sameLunaAnswerModel: `openai-codex/${options.answerModel}:${options.answerReasoning}`,
      sameLunaJudgeModel: `openai-codex/${options.judgeModel}:${options.judgeReasoning}`,
      identicalAnswerPromptsReuseCompletion: true,
      identicalFrozenOutcomesJudgedOnce: true,
      onlineVisibleFields: ["dialogue", "question"],
      onlineHiddenFields: ["id", "task", "memory", "evaluation", "metadata"],
      allFiveOnlineResultsFrozenBeforeGold: true,
      judgeConditionOpaque: true,
      retrievalBudget: options.budget,
      optimizationOrder: ["task-success", "injected-context-tokens", "assembly-p95"],
      formalInferenceMinimumCases: 60,
      developmentExclusion: { source: exclusion.source, count: exclusion.caseKeys.length, overlap: 0 },
    },
    summary,
    execution,
    onlineRows,
    scoredRows,
    runLunaBudget: budget.snapshot(),
    aggregateLunaBudget: ledger.ledger,
  };
  const resultPath = resolve(options.output || join(resultDir, `${runId}.json`));
  await atomicJson(resultPath, report);
  process.stdout.write(`${JSON.stringify({ resultPath, frozenDir, summary, runLunaBudget: budget.snapshot() }, null, 2)}\n`);
} finally {
  answerClient.close();
  judgeClient.close();
}
