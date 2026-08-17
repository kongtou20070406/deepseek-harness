import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "../../../pi-idea-extension/src/core.js";
import { PiRpcClient, checkPiProviderAuth } from "../harness-performance/luna-client.mjs";
import { ModelRunBudgetLedger } from "../harness-performance/model-run-budget.mjs";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { buildMemSycoAnswerPrompt, memSycoJudgeCacheIdentity, parseMemSycoJudgeResponse } from "../memsyco/runner-core.mjs";
import { EVIDENCE_LADDER_VERSION } from "./compiler.mjs";
import { buildLongHorizonCase, compileLongHorizonAssemblies } from "./long-horizon-fixture.mjs";
import { judgeLongHorizonSolFrozen, longHorizonSolOrder, runLongHorizonSolOnline, summarizeLongHorizonSol } from "./long-horizon-sol-protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const manifestPath = join(here, "results", "long-horizon-sol-5pct-v2-manifest.json");
const dataPath = join(workspace, "research", "benchmarks", "third_party", "memsyco");
const cacheDir = join(here, ".cache-long-horizon-sol-5pct-v2");
const resultDir = join(here, "results");
const ledgerPath = join(resultDir, "long-horizon-sol-5pct-v2-budget.json");
const maxRunTokens = 10_000_000;
const CATALOG_MAX_OUTPUT = 128_000;
const model = "gpt-5.6-sol";
const reasoning = "max";
// Sol max occasionally has a >5 minute service tail on 20k-token post-hoc
// packets. A transport deadline must not become a synthetic benchmark miss;
// no-output lanes may resume from the same frozen prompt/cache identity.
const timeoutMs = 600_000;
const answerCharCap = 4096;
const judgeCharCap = 4096;
const ANSWER_SYSTEM = "You are the Sol subject in a frozen long-horizon memory benchmark. Do not use tools. Follow the current user request and return only a concise direct answer.";
const JUDGE_SYSTEM = "You are the Sol post-hoc evaluator in a frozen benchmark. Do not use tools. Return only the requested JSON object.";

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
      await new Promise((resolveWait) => setTimeout(resolveWait, 25 * 2 ** attempt));
    }
  }
}

async function sourceDigest() {
  const paths = [
    join(workspace, "pi-idea-extension", "src", "evidence-context-compiler.js"),
    join(here, "long-horizon-fixture.mjs"),
    join(here, "long-horizon-sol-protocol.mjs"),
  ];
  return hash(Buffer.concat(await Promise.all(paths.map((path) => readFile(path)))));
}

function validCompletion(value, cap) {
  const responseModel = String(value?.responseModel || "").replace(/^openai-codex\//, "");
  return typeof value?.text === "string" && value.text.trim() && value.text.length <= cap
    && !["error", "aborted"].includes(value.stopReason) && (!responseModel || responseModel === model);
}

async function cached(path, create, validate) {
  try {
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (validate(existing)) return { ...existing, cached: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const value = await create();
  if (!validate(value)) throw new Error(`Invalid completion ${path}`);
  await atomicJson(path, value);
  return { ...value, cached: false };
}

const authorized = process.argv.includes("--authorized-model-run");
const dryRun = process.argv.includes("--dry-run");
if (!authorized && !dryRun) throw new Error("Use --dry-run or --authorized-model-run");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const { manifestHash, ...manifestBody } = manifest;
if (`sha256:${hash(JSON.stringify(manifestBody))}` !== manifestHash) throw new Error("Manifest self-hash mismatch");
if (manifest.sample.percent !== 5 || manifest.sample.count !== 78) throw new Error("Formal Sol manifest must be fixed 5% / 78 cases");
if (manifest.compilerVersion !== EVIDENCE_LADDER_VERSION || manifest.sourceDigest !== await sourceDigest()) throw new Error("Compiler/source changed after Sol freeze");
const loaded = await loadMemSycoBench(dataPath);
if (loaded.sha256 !== manifest.dataSha256) throw new Error("Dataset digest drift");
const byKey = new Map(loaded.cases.map((item) => [item.selectorView.caseKey, item]));
const prepared = manifest.cases.map((frozen) => {
  const target = byKey.get(frozen.caseKey);
  const distractors = frozen.distractorCaseKeys.map((caseKey) => byKey.get(caseKey));
  if (!target || distractors.some((item) => !item)) throw new Error(`${frozen.caseKey} source case missing`);
  const longCase = buildLongHorizonCase(target, distractors, { targetAfter: frozen.targetAfter });
  const all = compileLongHorizonAssemblies(longCase, { rawBudget: manifest.assembly.rawBudget, compactBudget: manifest.assembly.compactBudget });
  const assemblies = { "raw-long": all["raw-long"], "evidence-ladder": all["evidence-ladder"] };
  for (const [condition, assembly] of Object.entries(assemblies)) {
    const expected = frozen.assemblies[condition];
    if (assembly.outputHash !== expected.outputHash || assembly.contextTokens !== expected.contextTokens) throw new Error(`${frozen.caseKey}/${condition} drift`);
  }
  return { target, longCase, assemblies };
});

const answerInputTokens = { "raw-long": 0, "evidence-ladder": 0 };
for (const { longCase, assemblies } of prepared) {
  for (const condition of Object.keys(answerInputTokens)) {
    answerInputTokens[condition] += estimateTokens(`${ANSWER_SYSTEM}\n${buildMemSycoAnswerPrompt(longCase.selectorView, assemblies[condition].context)}`);
  }
}
const preflight = {
  schema: 1,
  mode: dryRun ? "dry-run" : "authorized-model-run",
  modelCalls: 0,
  manifest: { path: manifestPath, hash: manifestHash, cases: prepared.length, percent: manifest.sample.percent },
  execution: { cpuOnly: true, gpuRequired: false, serial: true, phases: ["freeze-all-answers", "post-hoc-blind-judge"] },
  model: { answer: `${model}:${reasoning}`, judge: `${model}:${reasoning}`, tools: false },
  tokens: {
    maxObservedRunTokens: maxRunTokens,
    answerInputTokens,
    candidateAnswerInputReduction: 1 - answerInputTokens["evidence-ladder"] / answerInputTokens["raw-long"],
  },
  gate: { minimumCases: 60, confidence: 0.95, nonInferiorityMargin: 0.05, minimumCompression: 0.50, latencyP95Ms: 100 },
};
if (dryRun) {
  process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
  process.exit(0);
}

const auth = await checkPiProviderAuth("openai-codex", { timeoutMs: 30_000 });
if (!auth.ready) throw new Error("openai-codex authentication is not ready");
await mkdir(cacheDir, { recursive: true });
await mkdir(resultDir, { recursive: true });
const runId = `long-horizon-sol-5pct-${manifestHash.slice(-12)}`;
const frozenDir = join(resultDir, `${runId}-frozen-online`);
await mkdir(frozenDir, { recursive: true });
const budget = await new ModelRunBudgetLedger({
  path: ledgerPath,
  model,
  hardTokenLimit: maxRunTokens,
  hardCallLimit: prepared.length * 6,
}).load();

async function charged(client, prompt, { caseId, lane, cap }) {
  const system = lane.startsWith("answer") ? ANSWER_SYSTEM : JUDGE_SYSTEM;
  const reservation = budget.reserve({ prompt: `${system}\n${prompt}`, catalogMaxOutput: CATALOG_MAX_OUTPUT, runId, caseId, lane });
  let settled = false;
  try {
    const completion = await client.complete(prompt);
    if (!validCompletion(completion, cap)) throw new Error(`Invalid ${lane} completion`);
    completion.usage = await budget.settle(reservation, completion.usage);
    settled = true;
    return completion;
  } catch (error) {
    if (!settled) await budget.settle(reservation, null, { failed: true, error: error.message });
    throw error;
  }
}

async function answerCached(client, caseKey, condition, prompt) {
  const promptHash = hash(`${ANSWER_SYSTEM}\0${model}\0${reasoning}\0${prompt}`);
  const path = join(cacheDir, `answer-${condition}-${promptHash}.json`);
  return cached(path, async () => {
    let first;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await charged(client, prompt, { caseId: caseKey, lane: `answer-${condition}-attempt-${attempt}`, cap: answerCharCap });
      } catch (error) {
        first ||= error;
        if (attempt === 2) throw new AggregateError([first, error], `${caseKey}/${condition} failed twice`);
      }
    }
  }, (value) => validCompletion(value, answerCharCap));
}

const online = new Map();
const answerClient = new PiRpcClient({ timeoutMs, model, reasoningEffort: reasoning, systemPrompt: ANSWER_SYSTEM });
try {
  for (let index = 0; index < prepared.length; index += 1) {
    const { target, longCase, assemblies } = prepared[index];
    const answerOrder = longHorizonSolOrder(target.selectorView.caseKey, manifest.sample.seed);
    const sealed = await runLongHorizonSolOnline({
      selectorView: longCase.selectorView,
      conditionOrder: answerOrder,
      assemblies,
      answer: ({ caseKey, condition, prompt }) => answerCached(answerClient, caseKey, condition, prompt),
    });
    await atomicJson(join(frozenDir, `${target.selectorView.caseKey.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`), { caseKey: target.selectorView.caseKey, answerOrder, sealed });
    online.set(target.selectorView.caseKey, sealed);
    process.stdout.write(`answer ${index + 1}/${prepared.length} ${target.selectorView.caseKey}\n`);
  }
} finally {
  answerClient.close();
}

const scoredRows = [];
const judgeClient = new PiRpcClient({ timeoutMs, model, reasoningEffort: reasoning, systemPrompt: JUDGE_SYSTEM });
try {
  for (let index = 0; index < prepared.length; index += 1) {
    const { target } = prepared[index];
    const scored = await judgeLongHorizonSolFrozen({
      reference: target.reference,
      sealedByCondition: online.get(target.selectorView.caseKey),
      seed: manifest.sample.seed,
      judge: async ({ caseKey, laneToken, prompt }) => {
        const identity = memSycoJudgeCacheIdentity({ laneToken, model, reasoning, prompt });
        return cached(join(cacheDir, `sol-${identity.filename}`), () => charged(judgeClient, prompt, { caseId: caseKey, lane: identity.budgetLane, cap: judgeCharCap }), (value) => validCompletion(value, judgeCharCap) && parseMemSycoJudgeResponse(value.text).retrievalJudge.parseOk);
      },
    });
    scoredRows.push(...scored);
    process.stdout.write(`judge ${index + 1}/${prepared.length} ${target.selectorView.caseKey}\n`);
  }
} finally {
  judgeClient.close();
}

const summary = summarizeLongHorizonSol(scoredRows, { seed: manifest.sample.seed, confidence: 0.95, margin: 0.05, minimumCompression: 0.50, latencyP95Ms: 100 });
const report = { schema: 1, runId, generatedAt: new Date().toISOString(), preflight, allAnswersFrozenBeforeGoldJudging: true, summary, scoredRows, budget: budget.snapshot() };
const output = join(resultDir, `${runId}-result.json`);
await atomicJson(output, report);
process.stdout.write(`${JSON.stringify({ output, summary, budget: budget.snapshot() }, null, 2)}\n`);
