import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { sampleMemSycoByTaskPercent } from "../memsyco/runner-core.mjs";
import { runMemSycoAssemblyAblation } from "./memsyco-ablation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const args = new Map(process.argv.slice(2).map((argument) => {
  if (!argument.startsWith("--") || !argument.includes("=")) throw new Error(`Expected --name=value, received ${JSON.stringify(argument)}`);
  const index = argument.indexOf("=");
  return [argument.slice(2, index), argument.slice(index + 1)];
}));
const allowed = new Set(["data", "sample-percent", "seed", "budgets", "conditions", "output"]);
for (const name of args.keys()) if (!allowed.has(name)) throw new Error(`Unknown option --${name}`);
const samplePercent = Number(args.get("sample-percent") || 5);
if (samplePercent !== 5) throw new Error("This frozen pilot requires --sample-percent=5");
const seed = args.get("seed") || "memsyco-five-local-5pct-v1";
const budgets = (args.get("budgets") || "512,1024,2048").split(",").map(Number);
if (budgets.some((value) => !Number.isSafeInteger(value) || value < 128)) throw new Error("--budgets must be comma-separated integers >=128");
const conditions = (args.get("conditions") || "raw,positive-only,gc-only,bidirectional,bidirectional-heat").split(",");
const data = resolve(args.get("data") || join(workspace, "research", "benchmarks", "third_party", "memsyco"));
const loaded = await loadMemSycoBench(data);
const selected = sampleMemSycoByTaskPercent(loaded.cases, { percent: samplePercent, seed });
const result = runMemSycoAssemblyAblation(selected, { conditions, budgets });
const ruleCounts = {};
const rootReasonCounts = {};
for (const row of result.rows) {
  if (!row.manifest) continue;
  for (const item of row.manifest.dropped || []) {
    ruleCounts[item.ruleId] = (ruleCounts[item.ruleId] || 0) + 1;
  }
  for (const root of row.manifest.roots || []) {
    for (const reason of root.reasons || []) rootReasonCounts[reason] = (rootReasonCounts[reason] || 0) + 1;
  }
}
const sampleManifests = [];
const sampledGroups = new Set();
for (const row of result.rows) {
  if (!row.manifest) continue;
  const group = `${row.condition}\0${row.budget}\0${row.overflow ? "overflow" : "complete"}`;
  if (sampledGroups.has(group)) continue;
  sampledGroups.add(group);
  sampleManifests.push({ caseKey: row.caseKey, condition: row.condition, budget: row.budget, overflow: row.overflow, manifest: row.manifest });
}
const report = {
  schema: 1,
  benchmark: "MemSyco-Bench",
  mode: "assembly-only-no-model-calls",
  generatedAt: new Date().toISOString(),
  data: { path: data, sha256: loaded.sha256, schemaVersion: loaded.schemaVersion },
  sample: { seed, percent: samplePercent, total: selected.length },
  protocol: {
    onlineVisibleFields: ["dialogue", "question"],
    onlineHiddenFields: ["id", "task", "memory", "evaluation", "metadata"],
    goldSupportingTurnIdsAvailable: false,
    taskSuccessMeasured: false,
    optimizationOrder: ["task-success", "injected-context-tokens", "assembly-p95"],
  },
  summary: result.summary,
  diagnostics: { ruleCounts, rootReasonCounts, sampleManifests },
  rows: result.rows.map(({ context, manifest, ...row }) => row),
};
const output = resolve(args.get("output") || join(here, "results", `memsyco-assembly-${Date.now()}.json`));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, summary: report.summary }, null, 2)}\n`);
