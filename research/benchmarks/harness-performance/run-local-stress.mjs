import { performance } from "node:perf_hooks";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileContext, serializeMessage } from "../../../pi-idea-extension/src/context-compiler.js";
import { estimateTokens } from "../../../pi-idea-extension/src/core.js";
import { stressCases } from "./stress-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, "results");
await mkdir(resultsDir, { recursive: true });
const rows = [];

for (const item of stressCases()) {
  const started = performance.now();
  const result = compileContext({
    messages: item.messages,
    idea: item.p0,
    prompt: item.question,
    stage: item.stage,
    summaries: new Map(),
    liveTurns: 4,
    retrievalBudget: 6000,
    maxRetrievedUnits: 8,
    foldMinTokens: 4800,
    foldMaxTokens: 7200,
    localEvidenceIndex: true,
  });
  const selectionMs = performance.now() - started;
  const selectedText = result.selectedPassages.map((passage) => passage.quote).join("\n");
  const hits = item.required.filter((fragment) => selectedText.includes(fragment));
  const context = result.messages.map(serializeMessage).join("\n\n");
  rows.push({
    caseId: item.id,
    historyTurns: item.historyTurns,
    required: item.required,
    hits,
    fullCoverage: hits.length === item.required.length,
    recall: hits.length / item.required.length,
    selectedPassages: result.selectedPassages.length,
    selected: result.selectedPassages.map((passage) => ({ score: passage.score, quote: passage.quote })),
    contextTokens: estimateTokens(context),
    rawTokens: result.metrics.rawTokens,
    selectionMs,
  });
  process.stdout.write(`${item.id} coverage=${hits.length}/${item.required.length} ctx=${estimateTokens(context)} select=${selectionMs.toFixed(2)}ms\n`);
}

const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
};
const report = {
  schema: 1,
  at: new Date().toISOString(),
  cases: rows.length,
  fullCoverage: rows.filter((row) => row.fullCoverage).length / rows.length,
  evidenceRecall: rows.reduce((sum, row) => sum + row.recall, 0) / rows.length,
  meanContextTokens: rows.reduce((sum, row) => sum + row.contextTokens, 0) / rows.length,
  meanRawTokens: rows.reduce((sum, row) => sum + row.rawTokens, 0) / rows.length,
  medianSelectionMs: quantile(rows.map((row) => row.selectionMs), 0.5),
  p95SelectionMs: quantile(rows.map((row) => row.selectionMs), 0.95),
  byLength: Object.fromEntries([...new Set(rows.map((row) => row.historyTurns))].map((length) => {
    const subset = rows.filter((row) => row.historyTurns === length);
    return [length, {
      cases: subset.length,
      fullCoverage: subset.filter((row) => row.fullCoverage).length / subset.length,
      evidenceRecall: subset.reduce((sum, row) => sum + row.recall, 0) / subset.length,
      meanContextTokens: subset.reduce((sum, row) => sum + row.contextTokens, 0) / subset.length,
      medianSelectionMs: quantile(subset.map((row) => row.selectionMs), 0.5),
      p95SelectionMs: quantile(subset.map((row) => row.selectionMs), 0.95),
    }];
  })),
  rows,
};
const path = join(resultsDir, `local-stress-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ path, ...report, rows: undefined }, null, 2)}\n`);
