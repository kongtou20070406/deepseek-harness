import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { compileBidirectionalContext, EVIDENCE_CONTEXT_COMPILER_VERSION } from "./compiler.mjs";
import { memSycoHistoryMessages } from "./memsyco-ablation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const dataPath = join(workspace, "research", "benchmarks", "third_party", "memsyco");
const output = join(here, "results", "authority-v4-full-cpu-20260813.json");
const budget = 8192;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const quantile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};

const loaded = await loadMemSycoBench(dataPath);
const rows = [];
const wallStarted = performance.now();
for (const item of loaded.cases) {
  const messages = memSycoHistoryMessages(item.selectorView);
  const raw = compileBidirectionalContext({ messages, query: item.selectorView.question, condition: "raw", budget, liveBlocks: 1 });
  const candidate = compileBidirectionalContext({ messages, query: item.selectorView.question, condition: "bidirectional-heat", budget, liveBlocks: 1 });
  rows.push({
    caseKey: item.selectorView.caseKey,
    task: item.reference.task,
    rawTokens: raw.contextTokens,
    candidateTokens: candidate.contextTokens,
    assemblyMs: candidate.assemblyMs,
    overflow: candidate.overflow,
    authorityRelations: candidate.manifest?.authorityClosure?.relations?.length || 0,
    shadowedToLocatorOnly: candidate.manifest?.authorityClosure?.shadowedToLocatorOnly?.length || 0,
  });
}
const summarize = (values) => {
  const rawMean = mean(values.map((row) => row.rawTokens));
  const candidateMean = mean(values.map((row) => row.candidateTokens));
  return {
    n: values.length,
    rawTokensMean: rawMean,
    candidateTokensMean: candidateMean,
    tokenReduction: 1 - candidateMean / rawMean,
    candidateTokensP50: quantile(values.map((row) => row.candidateTokens), 0.5),
    candidateTokensP95: quantile(values.map((row) => row.candidateTokens), 0.95),
    assemblyMsMean: mean(values.map((row) => row.assemblyMs)),
    assemblyMsP50: quantile(values.map((row) => row.assemblyMs), 0.5),
    assemblyMsP95: quantile(values.map((row) => row.assemblyMs), 0.95),
    assemblyMsMax: Math.max(...values.map((row) => row.assemblyMs)),
  };
};
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  mode: "full-official-assembly-only-no-model-calls",
  compilerVersion: EVIDENCE_CONTEXT_COMPILER_VERSION,
  data: { path: dataPath, sha256: loaded.sha256, cases: loaded.cases.length },
  budget,
  wallMs: performance.now() - wallStarted,
  overflow: rows.filter((row) => row.overflow).length,
  summary: summarize(rows),
  authority: {
    casesWithRelations: rows.filter((row) => row.authorityRelations > 0).length,
    casesWithShadowing: rows.filter((row) => row.shadowedToLocatorOnly > 0).length,
    shadowedBlocks: rows.reduce((sum, row) => sum + row.shadowedToLocatorOnly, 0),
  },
  byTask: Object.fromEntries([...new Set(rows.map((row) => row.task))].map((task) => [task, summarize(rows.filter((row) => row.task === task))])),
  limitations: [
    "Assembly-only: this run does not measure answer correctness or authority correctness.",
    "Official MemSyco gold is never exposed to the online selector.",
  ],
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, summary: report.summary, authority: report.authority }, null, 2)}\n`);
