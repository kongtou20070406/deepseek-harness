import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { compileBidirectionalContext, compileEvidenceLadderContext, EVIDENCE_LADDER_VERSION } from "./compiler.mjs";
import { selectedVerbatimTurns } from "./local-ablation-protocol.mjs";
import { memSycoHistoryMessages } from "./memsyco-ablation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const dataPath = join(workspace, "research", "benchmarks", "third_party", "memsyco");
const outputPath = join(here, "results", "evidence-ladder-v5-full-cpu-20260813.json");
const budget = 8192;

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const loaded = await loadMemSycoBench(dataPath);
const rows = [];
for (const item of loaded.cases) {
  const messages = memSycoHistoryMessages(item.selectorView);
  const raw = compileBidirectionalContext({ messages, query: item.selectorView.question, condition: "raw", budget, liveBlocks: 1 });
  const ladder = compileEvidenceLadderContext({ messages, query: item.selectorView.question, budget });
  if (!raw.overflow) selectedVerbatimTurns(item.selectorView, raw);
  if (!ladder.overflow) selectedVerbatimTurns(item.selectorView, ladder);
  rows.push({
    caseKey: item.selectorView.caseKey,
    task: item.reference.task,
    rawTokens: raw.contextTokens ?? null,
    ladderTokens: ladder.contextTokens ?? null,
    rawAssemblyMs: raw.assemblyMs,
    ladderAssemblyMs: ladder.assemblyMs,
    overflow: ladder.overflow,
    selected: ladder.selectedBlocks.length,
    userSpineComplete: ladder.manifest?.ladder?.userSpineComplete ?? null,
    profile: ladder.manifest?.profile ?? null,
    outputHash: ladder.manifest?.outputHash ?? null,
  });
}

const completed = rows.filter((row) => !row.overflow);
const reductions = completed.map((row) => 1 - row.ladderTokens / row.rawTokens);
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  compilerVersion: EVIDENCE_LADDER_VERSION,
  data: { sha256: loaded.sha256, cases: loaded.cases.length },
  protocol: { modelCalls: 0, cpuOnly: true, serial: true, budget },
  summary: {
    completed: completed.length,
    overflow: rows.length - completed.length,
    tokens: {
      rawMean: mean(completed.map((row) => row.rawTokens)),
      ladderMean: mean(completed.map((row) => row.ladderTokens)),
      meanReductionFraction: mean(reductions),
      p05ReductionFraction: quantile(reductions, 0.05),
      p50ReductionFraction: quantile(reductions, 0.5),
    },
    assemblyMs: {
      mean: mean(completed.map((row) => row.ladderAssemblyMs)),
      p50: quantile(completed.map((row) => row.ladderAssemblyMs), 0.5),
      p95: quantile(completed.map((row) => row.ladderAssemblyMs), 0.95),
      max: Math.max(...completed.map((row) => row.ladderAssemblyMs)),
    },
    userSpineCompleteRate: mean(completed.map((row) => Number(row.userSpineComplete))),
  },
  byTask: Object.fromEntries([...new Set(rows.map((row) => row.task))].sort().map((task) => {
    const taskRows = completed.filter((row) => row.task === task);
    return [task, {
      n: taskRows.length,
      rawTokensMean: mean(taskRows.map((row) => row.rawTokens)),
      ladderTokensMean: mean(taskRows.map((row) => row.ladderTokens)),
      reductionFraction: mean(taskRows.map((row) => 1 - row.ladderTokens / row.rawTokens)),
      assemblyP95Ms: quantile(taskRows.map((row) => row.ladderAssemblyMs), 0.95),
    }];
  })),
  rows,
};
report.digest = createHash("sha256").update(JSON.stringify(report.rows)).digest("hex");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, summary: report.summary, byTask: report.byTask, digest: report.digest }, null, 2)}\n`);
