import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { parseMemSycoJudgeResponse, RunLunaBudgetGate } from "../memsyco/runner-core.mjs";
import { LunaBudgetLedger } from "../harness-performance/budget-ledger.mjs";
import { checkPiProviderAuth, PiRpcClient } from "../harness-performance/luna-client.mjs";
import { compileBidirectionalContext, compileEvidenceLadderContext, EVIDENCE_LADDER_VERSION } from "./compiler.mjs";
import { neutralEvidenceFromCompilation } from "./local-ablation-protocol.mjs";
import { memSycoHistoryMessages } from "./memsyco-ablation.mjs";
import {
  evidenceLadderOrder,
  judgeEvidenceLadderFrozen,
  runEvidenceLadderOnline,
  summarizeEvidenceLadder,
} from "./evidence-ladder-protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const dataPath = join(workspace, "research", "benchmarks", "third_party", "memsyco");
const resultDir = join(here, "results");
const cacheDir = join(here, ".cache-evidence-ladder-luna-gate-v4");
const manifestPath = join(resultDir, "evidence-ladder-luna-gate-v4-manifest.json");
const ledgerPath = join(workspace, "research", "benchmarks", "harness-performance", "luna-budget.json");
const seed = "proof-carrying-evidence-ladder-v5-unseen-hard-v4";
const taskCounts = Object.freeze({
  objective_fact_judgment: 8,
  personalized_memory_use: 8,
  memory_evidence_conflict: 6,
  contextual_scope_control: 5,
  valid_memory_selection: 5,
});
const sampleSize = Object.values(taskCounts).reduce((sum, value) => sum + value, 0);
const budgetTokens = 8192;
const maxRunTokens = 2_000_000;
const answerMaxTokens = 700;
const judgeMaxTokens = 550;
const model = "gpt-5.6-luna";
const reasoning = "low";

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

async function priorModelCaseKeys() {
  const names = await readdir(resultDir, { recursive: true });
  const keys = new Set();
  for (const name of names) {
    const normalized = String(name).replaceAll("\\", "/");
    if (!normalized.includes("frozen-online/")) continue;
    const match = normalized.match(/msy_([0-9a-f]{20})\.json$/u);
    if (match) keys.add(`msy:${match[1]}`);
  }
  return keys;
}

function assemble(item) {
  const messages = memSycoHistoryMessages(item.selectorView);
  const raw = compileBidirectionalContext({ messages, query: item.selectorView.question, condition: "raw", budget: budgetTokens, liveBlocks: 1 });
  const candidate = compileEvidenceLadderContext({ messages, query: item.selectorView.question, budget: budgetTokens });
  if (raw.overflow || candidate.overflow) throw new Error(`${item.selectorView.caseKey} overflowed during freeze`);
  return {
    raw: {
      overflow: false,
      context: raw.context,
      contextTokens: raw.contextTokens,
      assemblyMs: raw.assemblyMs,
      evidenceView: neutralEvidenceFromCompilation(item.selectorView, raw),
      outputHash: raw.manifest.outputHash,
      manifest: raw.manifest,
    },
    "evidence-ladder": {
      overflow: false,
      context: candidate.context,
      contextTokens: candidate.contextTokens,
      assemblyMs: candidate.assemblyMs,
      evidenceView: neutralEvidenceFromCompilation(item.selectorView, candidate),
      outputHash: candidate.manifest.outputHash,
      manifest: candidate.manifest,
    },
  };
}

function onlineHardness(item, assemblies) {
  const history = item.selectorView.history.map((turn) => turn.content).join("\n");
  const updates = history.match(/(?:\b(?:anymore|no longer|instead|rather|reconsider|shift|moved away|done with|lost interest|changed my mind)\b|现在|不再|改成|改为|转向|撤回|作废)/gi)?.length || 0;
  const coverage = assemblies["evidence-ladder"].manifest.coverage.lexicalCoverageRatio;
  const rawTokens = assemblies.raw.contextTokens;
  const generic = /(?:situation we discussed|what should i do|how would you approach|继续|接着|那个|这件事)/i.test(item.selectorView.question) ? 1 : 0;
  return (1 - Math.min(1, coverage)) * 1_000_000 + updates * 250_000 + generic * 100_000 + rawTokens * 100;
}

async function sourceDigest() {
  const paths = [
    join(workspace, "pi-idea-extension", "src", "evidence-context-compiler.js"),
    join(here, "evidence-ladder-protocol.mjs"),
    fileURLToPath(import.meta.url),
  ];
  const content = await Promise.all(paths.map((path) => readFile(path)));
  return hash(Buffer.concat(content));
}

async function freezeManifest(loaded) {
  const excluded = await priorModelCaseKeys();
  const candidates = [];
  for (const item of loaded.cases) {
    if (excluded.has(item.selectorView.caseKey)) continue;
    const assemblies = assemble(item);
    candidates.push({
      item,
      assemblies,
      hardness: onlineHardness(item, assemblies),
      tie: hash(`${seed}\0${item.selectorView.caseKey}`),
    });
  }
  const selected = [];
  for (const [task, count] of Object.entries(taskCounts)) {
    const pool = candidates.filter((row) => row.item.reference.task === task)
      .sort((left, right) => right.hardness - left.hardness || left.tie.localeCompare(right.tie));
    if (pool.length < count) throw new Error(`${task} has only ${pool.length} unseen cases`);
    selected.push(...pool.slice(0, count));
  }
  if (selected.length !== sampleSize) throw new Error(`Expected ${sampleSize}, selected ${selected.length}`);
  const digest = await sourceDigest();
  const manifest = {
    schema: 1,
    frozenAt: new Date().toISOString(),
    seed,
    label: "unseen online-safe adversarial Luna-low screen; frozen before any model answer",
    dataSha256: loaded.sha256,
    compilerVersion: EVIDENCE_LADDER_VERSION,
    sourceDigest: digest,
    excludedPriorModelCases: excluded.size,
    sampleSize,
    taskCounts,
    budgetTokens,
    model: `${model}:${reasoning}`,
    cases: selected.map(({ item, assemblies, hardness }) => ({
      caseKey: item.selectorView.caseKey,
      officialId: item.reference.officialId,
      task: item.reference.task,
      hardness,
      rawTokens: assemblies.raw.contextTokens,
      candidateTokens: assemblies["evidence-ladder"].contextTokens,
      rawOutputHash: assemblies.raw.outputHash,
      candidateOutputHash: assemblies["evidence-ladder"].outputHash,
    })),
  };
  manifest.manifestDigest = hash(JSON.stringify(manifest));
  await atomicJson(manifestPath, manifest);
  return manifest;
}

const authorized = process.argv.includes("--authorized-model-run");
const dryRun = process.argv.includes("--dry-run");
if (!authorized && !dryRun) throw new Error("Use --dry-run or --authorized-model-run");
await mkdir(resultDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });
const loaded = await loadMemSycoBench(dataPath);
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  manifest = await freezeManifest(loaded);
}
if (manifest.dataSha256 !== loaded.sha256 || manifest.compilerVersion !== EVIDENCE_LADDER_VERSION) throw new Error("Frozen manifest no longer matches data/compiler");
if (manifest.sourceDigest !== await sourceDigest()) throw new Error("Source changed after Luna manifest freeze");
const selected = manifest.cases.map((row) => {
  const item = loaded.cases.find((candidate) => candidate.selectorView.caseKey === row.caseKey);
  if (!item) throw new Error(`Missing frozen case ${row.caseKey}`);
  const assemblies = assemble(item);
  if (assemblies.raw.outputHash !== row.rawOutputHash || assemblies["evidence-ladder"].outputHash !== row.candidateOutputHash) {
    throw new Error(`${row.caseKey} assembly changed after freeze`);
  }
  return { item, assemblies, selection: row };
});

if (dryRun) {
  process.stdout.write(`${JSON.stringify({ dryRun: true, modelCalls: 0, manifestPath, manifest }, null, 2)}\n`);
  process.exit(0);
}

const auth = await checkPiProviderAuth("openai-codex");
if (!auth.ready) throw new Error(`Pi provider auth is not ready: ${auth.status}`);
const ledger = await new LunaBudgetLedger(ledgerPath).load();
const runBudget = new RunLunaBudgetGate({ ledger, maxTotal: maxRunTokens });
const client = new PiRpcClient({ model, reasoningEffort: reasoning, timeoutMs: 180_000 });
const runId = `evidence-ladder-luna-gate-${new Date().toISOString().replace(/[:.]/g, "-")}-${manifest.manifestDigest.slice(0, 8)}`;
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
  for (let index = 0; index < selected.length; index += 1) {
    const { item, assemblies, selection } = selected[index];
    const answerOrder = evidenceLadderOrder(item.selectorView.caseKey, seed);
    const sealed = await runEvidenceLadderOnline({
      selectorView: item.selectorView,
      conditionOrder: answerOrder,
      assemblies,
      answer: ({ caseKey, prompt }) => cachedCompletion(prompt, { caseId: caseKey, lane: "answer", maxTokens: answerMaxTokens, validate: validAnswer }),
    });
    await atomicJson(join(frozenDir, `${item.selectorView.caseKey.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`), { caseKey: item.selectorView.caseKey, answerOrder, sealed });
    const scored = await judgeEvidenceLadderFrozen({
      reference: item.reference,
      sealedByCondition: sealed,
      seed,
      judge: ({ caseKey, laneToken, prompt }) => cachedCompletion(prompt, { caseId: caseKey, lane: `judge-${laneToken}`, maxTokens: judgeMaxTokens, validate: validJudge }),
    });
    scoredRows.push(...scored);
    execution.push({ caseKey: item.selectorView.caseKey, task: item.reference.task, hardness: selection.hardness, answerOrder });
    process.stdout.write(`case ${index + 1}/${sampleSize} ${item.selectorView.caseKey}\n`);
  }
  const summary = summarizeEvidenceLadder(scoredRows, { seed });
  const report = {
    schema: 1,
    runId,
    generatedAt: new Date().toISOString(),
    label: "frozen unseen Luna-low adversarial screening gate; not a population estimate",
    manifestPath,
    manifestDigest: manifest.manifestDigest,
    protocol: {
      sampleSize,
      conditions: ["raw", "evidence-ladder"],
      compilerVersion: EVIDENCE_LADDER_VERSION,
      answerModel: `${model}:${reasoning}`,
      judgeModel: `${model}:${reasoning}`,
      assemblyUsesModel: false,
      cpuOnly: true,
      serial: true,
      solEligibleOnlyIfGatePassed: true,
    },
    execution,
    scoredRows,
    summary,
    solEligible: summary.gate.passed,
    runLunaBudget: runBudget.snapshot(),
  };
  const output = join(resultDir, `${runId}.json`);
  await atomicJson(output, report);
  process.stdout.write(`${JSON.stringify({ output, summary, solEligible: report.solEligible, runLunaBudget: report.runLunaBudget }, null, 2)}\n`);
} finally {
  client.close();
}
