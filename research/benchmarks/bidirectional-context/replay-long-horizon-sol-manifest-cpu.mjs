import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { EVIDENCE_LADDER_VERSION } from "./compiler.mjs";
import { buildLongHorizonCase, compileLongHorizonAssemblies, targetEvidenceCoverage } from "./long-horizon-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const manifestPath = join(here, "results", "long-horizon-sol-5pct-v1-manifest.json");
const outputPath = join(here, "results", "long-horizon-v6.2-on-sol-v1-cpu-replay.json");
const dataPath = join(workspace, "research", "benchmarks", "third_party", "memsyco");

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const loaded = await loadMemSycoBench(dataPath);
const byKey = new Map(loaded.cases.map((item) => [item.selectorView.caseKey, item]));
const rows = manifest.cases.map((frozen) => {
  const target = byKey.get(frozen.caseKey);
  const distractors = frozen.distractorCaseKeys.map((caseKey) => byKey.get(caseKey));
  const longCase = buildLongHorizonCase(target, distractors, { targetAfter: frozen.targetAfter });
  const assembly = compileLongHorizonAssemblies(longCase, {
    rawBudget: manifest.assembly.rawBudget,
    compactBudget: manifest.assembly.compactBudget,
  })["evidence-ladder"];
  const selectedTargetTurns = assembly.evidenceView
    .filter((entry) => entry.provenance.historyIndex >= longCase.targetRange.start
      && entry.provenance.historyIndex < longCase.targetRange.end)
    .map((entry) => ({
      targetTurnIndex: entry.provenance.historyIndex - longCase.targetRange.start,
      role: entry.provenance.role,
      verbatim: entry.verbatim,
    }));
  return {
    caseKey: frozen.caseKey,
    officialId: frozen.officialId,
    task: frozen.task,
    beforeTokens: frozen.assemblies["evidence-ladder"].contextTokens,
    afterTokens: assembly.contextTokens,
    beforeCoverage: frozen.assemblies["evidence-ladder"].targetEvidenceCoverage,
    afterCoverage: targetEvidenceCoverage(longCase, assembly),
    assemblyMs: assembly.assemblyMs,
    outputHash: assembly.outputHash,
    selectedTargetTurns,
  };
});
const summary = {
  cases: rows.length,
  compilerVersion: EVIDENCE_LADDER_VERSION,
  beforeTokensMean: mean(rows.map((row) => row.beforeTokens)),
  afterTokensMean: mean(rows.map((row) => row.afterTokens)),
  rawTokensMean: mean(manifest.cases.map((row) => row.assemblies["raw-long"].contextTokens)),
  compression: 1 - mean(rows.map((row) => row.afterTokens)) / mean(manifest.cases.map((row) => row.assemblies["raw-long"].contextTokens)),
  beforeCoverageMean: mean(rows.map((row) => row.beforeCoverage)),
  afterCoverageMean: mean(rows.map((row) => row.afterCoverage)),
  coverageImprovedCases: rows.filter((row) => row.afterCoverage > row.beforeCoverage).length,
  coverageRegressedCases: rows.filter((row) => row.afterCoverage < row.beforeCoverage).length,
  assemblyP95Ms: quantile(rows.map((row) => row.assemblyMs), 0.95),
};
await writeFile(outputPath, `${JSON.stringify({ schema: 1, sourceManifest: manifestPath, summary, rows }, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, summary }, null, 2)}\n`);
