import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { memSycoJudgeCacheIdentity, buildMemSycoJudgePrompt, parseMemSycoJudgeResponse } from "../memsyco/runner-core.mjs";
import {
  SOL_PAIRED_CONDITIONS,
  judgeSolPairedFrozen,
  summarizeSolPaired,
} from "./sol-paired-protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const manifestPath = join(here, "results", "sol-lsc-epc-5pct-manifest-20260813.json");
const cacheDir = join(here, ".cache-sol-paired");
const budgetPath = join(here, "results", "sol-lsc-epc-5pct-budget.json");
const outputPath = join(here, "results", "sol-lsc-epc-5pct-88050c81911c-result-partial.json");

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const { manifestHash, ...manifestBody } = manifest;
if (sha256(JSON.stringify(manifestBody)) !== manifestHash) throw new Error("Frozen manifest self-hash mismatch");
const loaded = await loadMemSycoBench(join(workspace, "research", "benchmarks", "third_party", "memsyco"));
if (loaded.sha256 !== manifest.data.sha256) throw new Error("Official dataset digest differs from frozen manifest");
const byKey = new Map(loaded.cases.map((item) => [item.reference.caseKey, item]));
const scoredRows = [];
const unscored = [];

for (const frozenCase of manifest.cases) {
  const safe = frozenCase.caseKey.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const onlinePath = join(here, "results", "sol-lsc-epc-5pct-88050c81911c-frozen-online", `${safe}.json`);
  const online = JSON.parse(await readFile(onlinePath, "utf8"));
  const sealedByCondition = Object.fromEntries(SOL_PAIRED_CONDITIONS.map((condition) => {
    const sealed = online.sealed?.[condition];
    if (!sealed?.sealed) throw new Error(`${frozenCase.caseKey}/${condition} is not sealed`);
    return [condition, Object.freeze(sealed)];
  }));
  const item = byKey.get(frozenCase.caseKey);
  try {
    const scored = await judgeSolPairedFrozen({
      reference: item.reference,
      sealedByCondition,
      seed: manifest.sample.seed,
      judge: async ({ laneToken, prompt }) => {
        const identity = memSycoJudgeCacheIdentity({
          laneToken,
          model: "gpt-5.6-sol",
          reasoning: "max",
          prompt,
        });
        const path = join(cacheDir, `sol-${identity.filename}`);
        const completion = JSON.parse(await readFile(path, "utf8"));
        if (!completion?.text || !parseMemSycoJudgeResponse(completion.text).retrievalJudge.parseOk) {
          throw new Error(`Invalid cached judge completion ${identity.filename}`);
        }
        return completion;
      },
    });
    scoredRows.push(...scored);
  } catch (error) {
    if (error?.code !== "ENOENT" && !/Invalid cached judge completion/.test(error.message)) throw error;
    unscored.push({ caseKey: frozenCase.caseKey, reason: error.code === "ENOENT" ? "missing-judge-cache" : "invalid-judge-cache" });
  }
}

const summary = summarizeSolPaired(scoredRows, {
  minimumSample: 60,
  nonInferiorityMargin: 0.05,
  confidence: 0.95,
  seed: manifest.sample.seed,
});
const budget = JSON.parse(await readFile(budgetPath, "utf8"));
const report = {
  schema: 1,
  runId: "sol-lsc-epc-5pct-88050c81911c",
  generatedAt: new Date().toISOString(),
  finalization: "existing-cache-only-no-model-calls",
  allOnlineAnswersFrozenBeforeGoldJudging: true,
  plannedCases: manifest.sample.count,
  scorableCases: summary.cases,
  unscoredCases: unscored,
  censoringCaveat: "The run stopped at the first invalid judge completion. Remaining cases are a suffix of the frozen seeded order, not independently missing at random; minimum-sample inference is reported per the frozen contract, but this deterministic truncation remains a limitation.",
  summary,
  scoredRows,
  budget,
};
await atomicJson(outputPath, report);
process.stdout.write(`${JSON.stringify({ output: outputPath, plannedCases: manifest.sample.count, scorableCases: summary.cases, unscoredCases: unscored.length, summary, budget: budget.usage }, null, 2)}\n`);
