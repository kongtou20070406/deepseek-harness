import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench, memSycoSelectorToPiMessages } from "./adapter.mjs";
import { summarizeMemSycoPaired } from "./protocol.mjs";
import {
  RunLunaBudgetGate,
  buildNeutralMemSycoEvidenceView,
  buildMemSycoAnswerPrompt,
  judgeFrozenMemSycoPair,
  memSycoConditionOrder,
  memSycoJudgeCacheIdentity,
  parseMemSycoRunnerArgs,
  runMemSycoOnlinePair,
  sampleMemSycoByTask,
} from "./runner-core.mjs";
import { makeMemSycoJudgeLaneToken, MEMSYCO_JUDGE_BLINDING_SCHEMA } from "./protocol.mjs";
import { LunaBudgetLedger } from "../harness-performance/budget-ledger.mjs";
import { LunaRpcClient, PiRpcClient } from "../harness-performance/luna-client.mjs";
import {
  compileDualTrackContext,
  evidenceTagPrompt,
  groupTurns,
  makeFoldUnits,
  parseEvidenceTags,
  serializeMessage,
} from "../../../pi-idea-extension/src/context-compiler.js";
import { estimateTokens } from "../../../pi-idea-extension/src/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const options = parseMemSycoRunnerArgs();
const dataPath = resolve(options.data || join(workspace, "research", "benchmarks", "third_party", "memsyco"));
const cacheDir = resolve(options.cache || join(here, ".cache"));
const resultDir = resolve(options.results || join(here, "results"));
const ledgerPath = resolve(options.ledger || join(workspace, "research", "benchmarks", "harness-performance", "luna-budget.json"));
const runId = `memsyco-${new Date().toISOString().replace(/[:.]/g, "-")}-${digest(options.seed).slice(0, 8)}`;
const cutoffAt = options.modelCutoff ? Date.parse(options.modelCutoff) : null;

await mkdir(cacheDir, { recursive: true });
await mkdir(resultDir, { recursive: true });

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function cached(path, create) {
  if (!options.noCache) {
    try { return { ...(JSON.parse(await readFile(path, "utf8"))), cached: true }; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const value = await create();
  await atomicJson(path, value);
  return { ...value, cached: false };
}

const loaded = await loadMemSycoBench(dataPath);
const selected = sampleMemSycoByTask(loaded.cases, { perTask: options.perTask, seed: options.seed });

function prepareCase(item) {
  // Fidelity choice: compiler sees history only. The current question is used
  // as its query and is inserted exactly once by buildMemSycoAnswerPrompt.
  const messages = memSycoSelectorToPiMessages(item.selectorView, { includeQuestion: false });
  const turns = groupTurns(messages);
  const split = Math.max(0, turns.length - options.liveTurns);
  const coldTurns = turns.slice(0, split);
  const units = makeFoldUnits(coldTurns, { minTokens: options.foldMinTokens, maxTokens: options.foldMaxTokens })
    .filter((unit) => unit.stable);
  if (!units.length) {
    throw new Error(`${item.selectorView.caseKey} produced no coldUnits; refusing a degenerate full-history comparison`);
  }
  return { item, messages, units };
}

const prepared = selected.map(prepareCase);
const validation = {
  dataPath,
  datasetSha256: loaded.sha256,
  schemaVersion: loaded.schemaVersion,
  selected: prepared.length,
  perTask: options.perTask,
  seed: options.seed,
  coldUnits: prepared.reduce((sum, item) => sum + item.units.length, 0),
  casesWithColdUnits: prepared.filter((item) => item.units.length > 0).length,
  historyOnlyCompilerInput: true,
  questionInjectedExactlyOnce: true,
  answerModels: [options.answerModel],
  tagModel: options.tagModel,
  judgeModel: options.judgeModel,
};

if (options.validateOnly) {
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
  process.exit(0);
}

if (options.dryRun) {
  const cases = prepared.map(({ item, messages, units }) => {
    const base = {
      messages,
      idea: "",
      stage: "",
      prompt: item.selectorView.question,
      liveTurns: options.liveTurns,
      retrievalBudget: options.retrievalBudget,
      maxRetrievedUnits: options.maxRetrievedUnits,
      foldMinTokens: options.foldMinTokens,
      foldMaxTokens: options.foldMaxTokens,
    };
    const local = compileDualTrackContext({ ...base, summaries: new Map() });
    const incompleteLuna = compileDualTrackContext({ ...base, summaries: new Map() });
    if (local.track !== "local-fallback" || incompleteLuna.track !== "local-fallback") {
      throw new Error(`${item.selectorView.caseKey} dry-run did not exercise deterministic local fallback`);
    }
    const localContext = local.compiled.messages.map(serializeMessage).join("\n\n");
    const fullHistory = messages.map(serializeMessage).join("\n\n");
    if (localContext === fullHistory) throw new Error(`${item.selectorView.caseKey} local path degenerated to identical full history`);
    const rawHistoryTokens = estimateTokens(fullHistory);
    const answerPrompt = buildMemSycoAnswerPrompt(item.selectorView, localContext);
    const questionWrapper = `<current_user_request>${item.selectorView.question}</current_user_request>`;
    if (answerPrompt.split(questionWrapper).length - 1 !== 1) throw new Error(`${item.selectorView.caseKey} did not inject exactly one current-question wrapper`);
    return {
      caseKey: item.selectorView.caseKey,
      task: item.reference.task,
      historyTurns: messages.length,
      coldUnits: units.length,
      localTrack: local.track,
      expectedLunaTrackAfterTagging: "luna-enhanced",
      localContextTokens: estimateTokens(localContext),
      rawHistoryTokens,
      localSelectedPassages: local.compiled.selectedPassages?.length || 0,
      conditionOrder: memSycoConditionOrder(item.selectorView.caseKey, options.seed),
      judgeOrder: memSycoConditionOrder(item.selectorView.caseKey, options.seed, { judge: true }),
    };
  });
  process.stdout.write(`${JSON.stringify({ ...validation, dryRun: true, lunaCalls: 0, cases }, null, 2)}\n`);
  process.exit(0);
}

const ledger = await new LunaBudgetLedger(ledgerPath).load();
const budget = new RunLunaBudgetGate({ ledger, maxTotal: options.maxLunaTokens });
const taggers = Array.from({ length: options.tagConcurrency }, () => new LunaRpcClient({
  timeoutMs: options.timeoutMs,
  model: options.tagModel,
  reasoningEffort: options.tagReasoning,
  ...(cutoffAt ? { deadlineAt: cutoffAt } : {}),
}));
const answerers = Array.from({ length: 2 }, () => new PiRpcClient({
  timeoutMs: options.timeoutMs,
  model: options.answerModel,
  reasoningEffort: options.answerReasoning,
  ...(cutoffAt ? { deadlineAt: cutoffAt } : {}),
}));
const judges = Array.from({ length: 2 }, () => new PiRpcClient({
  timeoutMs: options.timeoutMs,
  model: options.judgeModel,
  reasoningEffort: options.judgeReasoning,
  ...(cutoffAt ? { deadlineAt: cutoffAt } : {}),
}));

async function charged(client, prompt, { caseId, condition, maxTokens }) {
  const reservation = budget.reserve({ prompt, maxTokens, runId, caseId, condition });
  try {
    const completion = await client.complete(prompt);
    const usage = await budget.settle(reservation, completion.usage);
    return { ...completion, usage };
  } catch (error) {
    await budget.settle(reservation, null, { failed: true, error: error.message });
    throw error;
  }
}

async function indexUnit(client, caseKey, unit) {
  const prompt = evidenceTagPrompt(unit, { ideaHash: "memsyco-blind", stageHash: "memsyco-judgment" });
  const path = join(cacheDir, `tag-${digest(`${options.tagModel}\0${options.tagReasoning}\0${prompt}`)}.json`);
  const record = await cached(path, async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const completion = await charged(client, prompt, {
        caseId: caseKey,
        condition: "background-luna-tag",
        maxTokens: options.tagMaxTokens,
      });
      const parsed = parseEvidenceTags(completion.text, unit, { ideaHash: "memsyco-blind", stageHash: "memsyco-judgment" });
      if (parsed.valid) return { schema: 1, id: unit.id, claims: parsed.claims, rejected: parsed.rejected, usage: completion.usage, attempts: attempt };
    }
    throw new Error(`Luna tag JSON invalid after 3 attempts for ${caseKey}/${unit.id}`);
  });
  const normalized = parseEvidenceTags(JSON.stringify({ claims: record.claims }), unit, {
    ideaHash: "memsyco-blind",
    stageHash: "memsyco-judgment",
  });
  if (!normalized.valid) throw new Error(`Cached Luna tag invalid for ${caseKey}/${unit.id}`);
  return { ...record, claims: normalized.claims };
}

async function buildAllIndexes() {
  const summaries = new Map(prepared.map(({ item }) => [item.selectorView.caseKey, new Map()]));
  const jobs = prepared.flatMap(({ item, units }) => units.map((unit) => ({ caseKey: item.selectorView.caseKey, unit })));
  let next = 0;
  async function worker(client) {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      const record = await indexUnit(client, job.caseKey, job.unit);
      summaries.get(job.caseKey).set(job.unit.id, record);
      process.stdout.write(`index ${index + 1}/${jobs.length} ${job.caseKey} claims=${record.claims.length}${record.cached ? " cached" : ""}\n`);
    }
  }
  await Promise.all(taggers.slice(0, Math.min(taggers.length, jobs.length)).map(worker));
  return summaries;
}

const frozenDir = join(resultDir, `${runId}-frozen-online`);
await mkdir(frozenDir, { recursive: true });
const onlineRows = [];
const scoredRows = [];
const execution = [];

try {
  const indexes = await buildAllIndexes();
  for (const tagger of taggers) tagger.close();
  for (let caseIndex = 0; caseIndex < prepared.length; caseIndex += 1) {
    const { item, messages, units } = prepared[caseIndex];
    const base = {
      messages,
      idea: "",
      stage: "",
      prompt: item.selectorView.question,
      liveTurns: options.liveTurns,
      retrievalBudget: options.retrievalBudget,
      maxRetrievedUnits: options.maxRetrievedUnits,
      foldMinTokens: options.foldMinTokens,
      foldMaxTokens: options.foldMaxTokens,
    };
    const assemblies = {};
    for (const condition of ["local", "luna"]) {
      const started = performance.now();
      const dual = compileDualTrackContext({ ...base, summaries: condition === "luna" ? indexes.get(item.selectorView.caseKey) : new Map() });
      const assemblyMs = performance.now() - started;
      if (condition === "local" && dual.track !== "local-fallback") throw new Error(`${item.selectorView.caseKey} local path was ${dual.track}`);
      if (condition === "luna" && dual.track !== "luna-enhanced") throw new Error(`${item.selectorView.caseKey} Luna path was ${dual.track}`);
      if (dual.compiled.coldUnits.length !== units.length) throw new Error(`${item.selectorView.caseKey} cold unit identity drifted`);
      const context = dual.compiled.messages.map(serializeMessage).join("\n\n");
      assemblies[condition] = {
        context,
        // The answer sees compiler wrappers, but the judge gets a neutral
        // evidence view: exact selected cold quotes plus exact active messages,
        // with role/provenance preserved and selector labels removed.
        evidenceView: buildNeutralMemSycoEvidenceView({
          selectorView: item.selectorView,
          sourceMessages: messages,
          compiled: dual.compiled,
        }),
        contextTokens: estimateTokens(context),
        assemblyMs: Math.round(assemblyMs * 1000) / 1000,
        track: dual.track,
      };
    }
    if (assemblies.local.context === assemblies.luna.context) {
      throw new Error(`${item.selectorView.caseKey} produced identical local/Luna contexts; refusing a degenerate paid comparison`);
    }
    const conditionOrder = memSycoConditionOrder(item.selectorView.caseKey, options.seed);
    const laneByCondition = Object.fromEntries(conditionOrder.map((condition, lane) => [condition, lane]));
    const sealed = await runMemSycoOnlinePair({
      selectorView: item.selectorView,
      conditions: conditionOrder,
      assemble: async ({ condition }) => assemblies[condition],
      answer: async ({ caseKey, condition, prompt }) => {
        const key = digest(`${options.answerModel}\0${options.answerReasoning}\0${prompt}`);
        return cached(join(cacheDir, `answer-${condition}-${key}.json`), async () => charged(answerers[laneByCondition[condition]], prompt, {
          caseId: caseKey,
          condition: `answer-${condition}`,
          maxTokens: options.answerMaxTokens,
        }));
      },
    });

    // The complete pair is atomically persisted before reference/gold enters a
    // judge prompt. This file is the auditable online/evaluation boundary.
    const frozenPath = join(frozenDir, `${item.selectorView.caseKey.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
    await atomicJson(frozenPath, { caseKey: item.selectorView.caseKey, conditionOrder, sealed });
    onlineRows.push(...["local", "luna"].map((condition) => ({ ...sealed[condition], track: assemblies[condition].track })));

    const judgeOrder = memSycoConditionOrder(item.selectorView.caseKey, options.seed, { judge: true });
    const judgeTokens = judgeOrder.map((condition, ordinal) => ({
      condition,
      ordinal,
      laneToken: makeMemSycoJudgeLaneToken({ caseKey: item.selectorView.caseKey, seed: options.seed, ordinal }),
    }));
    const judgeClientByToken = new Map(judgeTokens.map(({ laneToken, ordinal }) => [laneToken, judges[ordinal]]));
    const scored = await judgeFrozenMemSycoPair({
      reference: item.reference,
      sealedByCondition: sealed,
      conditions: judgeOrder,
      seed: options.seed,
      judge: async ({ caseKey, laneToken, prompt }) => {
        // Constructing this prompt is the first point where gold is joined.
        // Neither the callback nor its cache/ledger metadata receives a
        // condition name; only the opaque per-case lane token crosses it.
        const client = judgeClientByToken.get(laneToken);
        if (!client) throw new Error(`Unknown opaque judge lane ${laneToken}`);
        const cacheIdentity = memSycoJudgeCacheIdentity({
          laneToken,
          model: options.judgeModel,
          reasoning: options.judgeReasoning,
          prompt,
        });
        return cached(join(cacheDir, cacheIdentity.filename), async () => charged(client, prompt, {
          caseId: caseKey,
          condition: cacheIdentity.budgetLane,
          maxTokens: options.judgeMaxTokens,
        }));
      },
    });
    scoredRows.push(...scored);
    execution.push({ caseKey: item.selectorView.caseKey, task: item.reference.task, conditionOrder, judgeOrder, frozenPath });
    process.stdout.write(`run ${caseIndex + 1}/${prepared.length} ${item.selectorView.caseKey} local=${scored.find((row) => row.condition === "local")?.answerCorrect} luna=${scored.find((row) => row.condition === "luna")?.answerCorrect}\n`);
  }

  const summary = summarizeMemSycoPaired(scoredRows, {
    nonInferiorityMargin: 0.10,
    minimumSample: 60,
    seed: Number.parseInt(digest(options.seed).slice(0, 8), 16),
  });
  const report = {
    schema: 1,
    benchmark: "MemSyco-Bench",
    runId,
    generatedAt: new Date().toISOString(),
    data: { path: dataPath, sha256: loaded.sha256, schemaVersion: loaded.schemaVersion, counts: loaded.counts },
    protocol: {
      seed: options.seed,
      perTask: options.perTask,
      sample: prepared.length,
      conditions: { local: "deterministic-local-raw-passage", luna: "Luna-tags-plus-deterministic-local-fusion" },
      sameAnswerModelAcrossConditions: true,
      answerModel: `openai-codex/${options.answerModel}:${options.answerReasoning}`,
      tagModel: `openai-codex/${options.tagModel}:${options.tagReasoning}`,
      judgeModel: `openai-codex/${options.judgeModel}:${options.judgeReasoning}`,
      onlineVisibleFields: ["dialogue", "question"],
      onlineHiddenFields: ["id", "task", "memory", "evaluation", "metadata"],
      onlineFrozenBeforeJudging: true,
      judgeBlindingSchema: MEMSYCO_JUDGE_BLINDING_SCHEMA,
      judgeConditionOpaque: true,
      judgeEvidenceView: "verbatim-cold-selection-plus-active-live-messages",
      historyOnlyCompilerInput: true,
      questionInjectedExactlyOnce: true,
      commonAuthorityInstructionBothConditions: true,
      conditionOrderBalancedByCaseHash: true,
      judgeOrderReversedFromAnswerOrder: true,
      retrievalBudget: options.retrievalBudget,
      liveTurns: options.liveTurns,
      foldMinTokens: options.foldMinTokens,
      foldMaxTokens: options.foldMaxTokens,
      optimizationOrder: ["task-success", "injected-context-tokens", "assembly-p50-p95"],
      nonInferiorityMarginPercentagePoints: 10,
      formalInferenceMinimumPairs: 60,
      modelCutoff: options.modelCutoff,
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
  for (const tagger of taggers) tagger.close();
  for (const answerer of answerers) answerer.close();
  for (const judge of judges) judge.close();
}
