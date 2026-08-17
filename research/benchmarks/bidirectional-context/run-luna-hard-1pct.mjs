import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { buildMemSycoJudgePrompt, parseMemSycoJudgeResponse, RunLunaBudgetGate } from "../memsyco/runner-core.mjs";
import { LunaBudgetLedger } from "../harness-performance/budget-ledger.mjs";
import { checkPiProviderAuth, PiRpcClient } from "../harness-performance/luna-client.mjs";
import { compileBidirectionalContext, EVIDENCE_CONTEXT_COMPILER_VERSION } from "./compiler.mjs";
import { memSycoHistoryMessages } from "./memsyco-ablation.mjs";
import { neutralEvidenceFromCompilation } from "./local-ablation-protocol.mjs";
import {
  judgeSolPairedFrozen,
  runSolPairedOnline,
  solPairedOrder,
  summarizeSolPaired,
} from "./sol-paired-protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const dataPath = join(workspace, "research", "benchmarks", "third_party", "memsyco");
const resultDir = join(here, "results");
const cacheDir = join(here, ".cache-luna-hard-1pct");
const ledgerPath = join(workspace, "research", "benchmarks", "harness-performance", "luna-budget.json");
const seed = "lsc-epc-authority-v4-hard-1pct-v1";
const sampleSize = 16;
const perTask = 8;
const budgetTokens = 8192;
const maxRunTokens = 2_000_000;
const answerMaxTokens = 700;
const judgeMaxTokens = 550;
const model = "gpt-5.6-luna";
const reasoning = "low";
const priorDiscordant = new Set([
  "msy:2e3140272dd2c8ab18fe",
  "msy:331408f2451aeb3e95ef",
  "msy:8e6c8e8f2c68d1422546",
  "msy:d2314f405a4f27a326bb",
  "msy:e35758f067c3177cebb0",
  "msy:eb2ae7515c5d8d276ada",
]);

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt === 5) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20 * 2 ** attempt));
    }
  }
  throw lastError;
}

function onlineHardness(item) {
  const history = item.selectorView.history.map((turn) => turn.content).join("\n");
  const updates = history.match(/(?:\b(?:now|anymore|no longer|instead|rather|reconsider|shift|moved away|done with|lost interest|changed my mind)\b|现在|不再|改成|改为|转向|撤回|作废)/gi)?.length || 0;
  const generic = /(?:situation we discussed|what should i do|how would you approach|继续|接着|那个|这件事)/i.test(item.selectorView.question) ? 1 : 0;
  return updates * 1_000_000 + generic * 500_000 + Math.min(history.length, 499_999);
}

function selectHardCases(cases) {
  const chosen = [];
  const add = (item, selectionReason) => {
    if (!item || chosen.some((row) => row.item.selectorView.caseKey === item.selectorView.caseKey)) return;
    chosen.push({ item, selectionReason, onlineHardness: onlineHardness(item) });
  };
  for (const key of priorDiscordant) add(cases.find((item) => item.selectorView.caseKey === key), "prior-sol-authority-discordant");
  for (const task of ["valid_memory_selection", "contextual_scope_control"]) {
    const need = perTask - chosen.filter((row) => row.item.reference.task === task).length;
    const pool = cases.filter((item) => item.reference.task === task && !priorDiscordant.has(item.selectorView.caseKey))
      .map((item) => ({ item, score: onlineHardness(item), tie: hash(`${seed}\0${item.selectorView.caseKey}`) }))
      .sort((left, right) => right.score - left.score || left.tie.localeCompare(right.tie));
    for (const row of pool.slice(0, need)) add(row.item, "online-safe-hardness-score");
  }
  if (chosen.length !== sampleSize) throw new Error(`Expected ${sampleSize} hard cases, selected ${chosen.length}`);
  return chosen;
}

function assemble(item, condition) {
  const result = compileBidirectionalContext({
    messages: memSycoHistoryMessages(item.selectorView),
    query: item.selectorView.question,
    condition,
    budget: budgetTokens,
    liveBlocks: 1,
  });
  if (result.overflow) throw new Error(`${item.selectorView.caseKey}/${condition} overflowed`);
  return {
    overflow: false,
    context: result.context,
    contextTokens: result.contextTokens,
    assemblyMs: result.assemblyMs,
    evidenceView: neutralEvidenceFromCompilation(item.selectorView, result),
    outputHash: result.manifest.outputHash,
    manifest: result.manifest,
  };
}

const authorized = process.argv.includes("--authorized-model-run");
const dryRun = process.argv.includes("--dry-run");
if (!authorized && !dryRun) throw new Error("Use --dry-run or the explicitly authorized --authorized-model-run flag");
await mkdir(resultDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });
const loaded = await loadMemSycoBench(dataPath);
const selected = selectHardCases(loaded.cases);
const prepared = selected.map((row) => ({
  ...row,
  assemblies: Object.fromEntries(["raw", "bidirectional-heat"].map((condition) => [condition, assemble(row.item, condition)])),
}));
const selection = prepared.map(({ item, selectionReason, onlineHardness: score, assemblies }) => ({
  caseKey: item.selectorView.caseKey,
  officialId: item.reference.officialId,
  task: item.reference.task,
  selectionReason,
  onlineHardness: score,
  contextTokens: { raw: assemblies.raw.contextTokens, authorityV4: assemblies["bidirectional-heat"].contextTokens },
  authorityRelations: assemblies["bidirectional-heat"].manifest.authorityClosure.relations.length,
}));

if (dryRun) {
  process.stdout.write(`${JSON.stringify({
    dryRun: true,
    modelCalls: 0,
    sample: sampleSize,
    percentOfOfficial: sampleSize / loaded.cases.length * 100,
    compilerVersion: EVIDENCE_CONTEXT_COMPILER_VERSION,
    model: `${model}:${reasoning}`,
    selection,
  }, null, 2)}\n`);
  process.exit(0);
}

const auth = await checkPiProviderAuth("openai-codex");
if (!auth.ready) throw new Error(`Pi provider auth is not ready: ${auth.status}`);
const ledger = await new LunaBudgetLedger(ledgerPath).load();
const runBudget = new RunLunaBudgetGate({ ledger, maxTotal: maxRunTokens });
const client = new PiRpcClient({ model, reasoningEffort: reasoning, timeoutMs: 180_000 });
const runId = `luna-hard-1pct-${new Date().toISOString().replace(/[:.]/g, "-")}-${hash(seed).slice(0, 8)}`;
const frozenDir = join(resultDir, `${runId}-frozen-online`);
await mkdir(frozenDir, { recursive: true });

async function cachedCompletion(prompt, { caseId, lane, maxTokens, validate }) {
  const promptHash = hash(`${model}\0${reasoning}\0${prompt}`);
  const path = join(cacheDir, `${lane.split("-")[0]}-${promptHash}.json`);
  try {
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (validate(existing)) return { ...existing, cached: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const reservation = runBudget.reserve({ prompt, maxTokens, runId, caseId, condition: lane });
  let settled = false;
  try {
    const completion = await client.complete(prompt);
    if (!validate(completion)) throw new Error(`Invalid completion for ${caseId}/${lane}`);
    completion.usage = await runBudget.settle(reservation, completion.usage);
    settled = true;
    await atomicJson(path, completion);
    return { ...completion, cached: false };
  } catch (error) {
    if (!settled) await runBudget.settle(reservation, null, { failed: true, error: error.message });
    throw error;
  }
}

const validAnswer = (value) => typeof value?.text === "string" && value.text.trim() && !["error", "aborted"].includes(value.stopReason);
const validJudge = (value) => validAnswer(value) && parseMemSycoJudgeResponse(value.text).retrievalJudge.parseOk;
const scoredRows = [];
const execution = [];
try {
  for (let index = 0; index < prepared.length; index += 1) {
    const { item, assemblies, selectionReason } = prepared[index];
    const answerOrder = solPairedOrder(item.selectorView.caseKey, seed);
    const sealed = await runSolPairedOnline({
      selectorView: item.selectorView,
      conditionOrder: answerOrder,
      assemblies,
      answer: ({ caseKey, prompt }) => cachedCompletion(prompt, { caseId: caseKey, lane: "answer", maxTokens: answerMaxTokens, validate: validAnswer }),
    });
    await atomicJson(join(frozenDir, `${item.selectorView.caseKey.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`), { caseKey: item.selectorView.caseKey, answerOrder, sealed });
    const scored = await judgeSolPairedFrozen({
      reference: item.reference,
      sealedByCondition: sealed,
      seed,
      judge: ({ caseKey, laneToken, prompt }) => cachedCompletion(prompt, { caseId: caseKey, lane: `judge-${laneToken}`, maxTokens: judgeMaxTokens, validate: validJudge }),
    });
    scoredRows.push(...scored);
    execution.push({ caseKey: item.selectorView.caseKey, task: item.reference.task, selectionReason, answerOrder });
    process.stdout.write(`case ${index + 1}/${sampleSize} ${item.selectorView.caseKey}\n`);
  }
  const summary = summarizeSolPaired(scoredRows, { minimumSample: 60, nonInferiorityMargin: 0.05, seed });
  summary.protocol = "memsyco-luna-low-hard-1pct-raw-vs-authority-v4-diagnostic";
  summary.adoptionGate.performanceGatePassed = null;
  summary.adoptionGate.tokenComparisonEligible = null;
  const report = {
    schema: 1,
    runId,
    generatedAt: new Date().toISOString(),
    label: "dev-tuned hard-case diagnostic; not an unbiased estimate and not an adoption gate",
    data: { sha256: loaded.sha256, totalRows: loaded.cases.length },
    protocol: {
      sample: sampleSize,
      percentOfOfficial: sampleSize / loaded.cases.length * 100,
      tasks: ["valid_memory_selection", "contextual_scope_control"],
      conditions: ["raw", "bidirectional-heat"],
      compilerVersion: EVIDENCE_CONTEXT_COMPILER_VERSION,
      assemblyUsesModel: false,
      answerModel: `${model}:${reasoning}`,
      judgeModel: `${model}:${reasoning}`,
      budgetTokens,
      selectionIncludesPriorDiscordantCases: true,
      noFormalInference: true,
    },
    selection,
    execution,
    scoredRows,
    summary,
    runLunaBudget: runBudget.snapshot(),
  };
  const output = join(resultDir, `${runId}.json`);
  await atomicJson(output, report);
  process.stdout.write(`${JSON.stringify({ output, summary, runLunaBudget: runBudget.snapshot() }, null, 2)}\n`);
} finally {
  client.close();
}
