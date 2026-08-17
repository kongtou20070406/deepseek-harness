import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "../../../pi-idea-extension/src/core.js";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { parseMemSycoJudgeResponse, RunLunaBudgetGate } from "../memsyco/runner-core.mjs";
import { LunaBudgetLedger } from "../harness-performance/budget-ledger.mjs";
import { checkPiProviderAuth, PiRpcClient } from "../harness-performance/luna-client.mjs";
import { EVIDENCE_LADDER_VERSION } from "./compiler.mjs";
import { buildLongHorizonCase, compileLongHorizonAssemblies, targetEvidenceCoverage } from "./long-horizon-fixture.mjs";
import { judgeLongHorizonFrozen, longHorizonOrder, runLongHorizonOnline, summarizeLongHorizon } from "./long-horizon-protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const dataPath = join(workspace, "research", "benchmarks", "third_party", "memsyco");
const resultDir = join(here, "results");
const cacheDir = join(here, ".cache-long-horizon-luna-gate-v2");
const manifestPath = join(resultDir, "long-horizon-luna-gate-v2-manifest.json");
const ledgerPath = join(workspace, "research", "benchmarks", "harness-performance", "luna-budget.json");
const seed = "pi-idea-proof-carrying-dialogue-islands-long-horizon-v2";
const taskCounts = Object.freeze({
  objective_fact_judgment: 4,
  personalized_memory_use: 4,
  memory_evidence_conflict: 3,
  contextual_scope_control: 2,
  valid_memory_selection: 3,
});
const sampleSize = Object.values(taskCounts).reduce((sum, value) => sum + value, 0);
const distractorCount = 8;
const rawBudget = 32768;
const compactBudget = 8192;
const maxRunTokens = 5_000_000;
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
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt === 5) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20 * 2 ** attempt));
    }
  }
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

function onlineHardness(item) {
  const historyTokens = estimateTokens(item.selectorView.history.map((turn) => turn.content).join("\n"));
  const generic = /(?:situation we discussed|which approach|which option|best (?:fits|suits)|what should|how would)/i.test(item.selectorView.question) ? 1 : 0;
  return generic * 1_000_000 + historyTokens;
}

function chooseDistractors(target, pool) {
  return pool.filter((item) => item.selectorView.caseKey !== target.selectorView.caseKey
      && item.reference.task !== target.reference.task)
    .map((item) => ({ item, tie: hash(`${seed}\0${target.selectorView.caseKey}\0${item.selectorView.caseKey}`) }))
    .sort((left, right) => left.tie.localeCompare(right.tie))
    .slice(0, distractorCount)
    .map((row) => row.item);
}

function targetAfter(target) {
  return 2 + (Number.parseInt(hash(`${seed}\0depth\0${target.selectorView.caseKey}`).slice(0, 8), 16) % 3);
}

async function sourceDigest() {
  const paths = [
    join(workspace, "pi-idea-extension", "src", "evidence-context-compiler.js"),
    join(here, "long-horizon-fixture.mjs"),
    join(here, "long-horizon-protocol.mjs"),
    fileURLToPath(import.meta.url),
  ];
  return hash(Buffer.concat(await Promise.all(paths.map((path) => readFile(path)))));
}

function buildFrozenCase(target, distractorKeys, targetPosition, loaded) {
  const distractors = distractorKeys.map((caseKey) => {
    const item = loaded.cases.find((candidate) => candidate.selectorView.caseKey === caseKey);
    if (!item) throw new Error(`Missing distractor ${caseKey}`);
    return item;
  });
  const longCase = buildLongHorizonCase(target, distractors, { targetAfter: targetPosition });
  const assemblies = compileLongHorizonAssemblies(longCase, { rawBudget, compactBudget });
  return { longCase, assemblies };
}

async function freezeManifest(loaded) {
  const excluded = await priorModelCaseKeys();
  const pool = loaded.cases.filter((item) => !excluded.has(item.selectorView.caseKey));
  const selected = [];
  for (const [task, count] of Object.entries(taskCounts)) {
    const taskPool = pool.filter((item) => item.reference.task === task)
      .map((item) => ({ item, hardness: onlineHardness(item), tie: hash(`${seed}\0target\0${item.selectorView.caseKey}`) }))
      .sort((left, right) => right.hardness - left.hardness || left.tie.localeCompare(right.tie));
    if (taskPool.length < count) throw new Error(`${task} has only ${taskPool.length} unseen targets`);
    selected.push(...taskPool.slice(0, count));
  }
  const cases = selected.map(({ item: target, hardness }) => {
    const distractors = chooseDistractors(target, pool);
    if (distractors.length !== distractorCount) throw new Error(`${target.selectorView.caseKey} lacks distractors`);
    const position = targetAfter(target);
    const { longCase, assemblies } = buildFrozenCase(target, distractors.map((item) => item.selectorView.caseKey), position, loaded);
    const coverage = Object.fromEntries(Object.entries(assemblies).map(([condition, assembly]) => [condition, targetEvidenceCoverage(longCase, assembly)]));
    return {
      caseKey: target.selectorView.caseKey,
      officialId: target.reference.officialId,
      task: target.reference.task,
      hardness,
      distractorCaseKeys: distractors.map((item) => item.selectorView.caseKey),
      targetAfter: position,
      totalTurns: longCase.selectorView.history.length,
      contextTokens: Object.fromEntries(Object.entries(assemblies).map(([condition, assembly]) => [condition, assembly.contextTokens])),
      targetEvidenceCoverage: coverage,
      outputHashes: Object.fromEntries(Object.entries(assemblies).map(([condition, assembly]) => [condition, assembly.outputHash])),
    };
  });
  const manifest = {
    schema: 1,
    frozenAt: new Date().toISOString(),
    seed,
    label: "unseen multi-project long-horizon Luna-low screen; frozen before model answers",
    dataSha256: loaded.sha256,
    compilerVersion: EVIDENCE_LADDER_VERSION,
    sourceDigest: await sourceDigest(),
    excludedPriorModelCases: excluded.size,
    sampleSize,
    taskCounts,
    distractorCount,
    rawBudget,
    compactBudget,
    model: `${model}:${reasoning}`,
    cases,
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
if (manifest.sourceDigest !== await sourceDigest()) throw new Error("Source changed after long-horizon freeze");

const selected = manifest.cases.map((row) => {
  const target = loaded.cases.find((candidate) => candidate.selectorView.caseKey === row.caseKey);
  if (!target) throw new Error(`Missing target ${row.caseKey}`);
  const { longCase, assemblies } = buildFrozenCase(target, row.distractorCaseKeys, row.targetAfter, loaded);
  for (const [condition, assembly] of Object.entries(assemblies)) {
    if (assembly.outputHash !== row.outputHashes[condition]) throw new Error(`${row.caseKey}/${condition} changed after freeze`);
  }
  return { target, longCase, assemblies, selection: row };
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
const runId = `long-horizon-luna-gate-${new Date().toISOString().replace(/[:.]/g, "-")}-${manifest.manifestDigest.slice(0, 8)}`;
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
    const { target, longCase, assemblies, selection } = selected[index];
    const answerOrder = longHorizonOrder(longCase.selectorView.caseKey, seed);
    const sealed = await runLongHorizonOnline({
      selectorView: longCase.selectorView,
      conditionOrder: answerOrder,
      assemblies,
      answer: ({ caseKey, condition, prompt }) => cachedCompletion(prompt, { caseId: caseKey, lane: `answer-${condition}`, maxTokens: answerMaxTokens, validate: validAnswer }),
    });
    await atomicJson(join(frozenDir, `${longCase.selectorView.caseKey.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`), { caseKey: longCase.selectorView.caseKey, answerOrder, sealed });
    const scored = await judgeLongHorizonFrozen({
      reference: target.reference,
      sealedByCondition: sealed,
      seed,
      judge: ({ caseKey, laneToken, prompt }) => cachedCompletion(prompt, { caseId: caseKey, lane: `judge-${laneToken}`, maxTokens: judgeMaxTokens, validate: validJudge }),
    });
    scoredRows.push(...scored);
    execution.push({ caseKey: target.selectorView.caseKey, task: target.reference.task, answerOrder, targetEvidenceCoverage: selection.targetEvidenceCoverage });
    process.stdout.write(`case ${index + 1}/${sampleSize} ${target.selectorView.caseKey}\n`);
  }
  const summary = summarizeLongHorizon(scoredRows);
  const report = {
    schema: 1,
    runId,
    generatedAt: new Date().toISOString(),
    label: "frozen unseen multi-project long-horizon Luna-low gate; rolling baseline is transparent extractive simulation, not proprietary Codex compaction",
    manifestPath,
    manifestDigest: manifest.manifestDigest,
    protocol: { sampleSize, distractorCount, rawBudget, compactBudget, compilerVersion: EVIDENCE_LADDER_VERSION, model: `${model}:${reasoning}`, cpuOnly: true, serial: true },
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
