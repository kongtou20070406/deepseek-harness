import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadGarageBench } from "./adapter.mjs";
import {
  aggregateGarageDiagnostics,
  diagnoseGarageSelection,
  fixedStratifiedGarageSample,
  garageEvaluationStratum,
  garageSampleManifest,
  summarizeGaragePair,
} from "./metrics.mjs";
import {
  GARAGE_SELECTION_PROTOCOL,
  selectJudgmentEvidenceSet,
  selectWithProductionLocal,
} from "./selector.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    "Usage: node research/benchmarks/garage/run-selection.mjs [options]",
    "  --data <path>          official GaRAGe root or JSONL file",
    "  --sample <n|all>       fixed stratified sample (default: 240)",
    "  --seed <text>          deterministic sample seed",
    "  --exclude-seed <text>  exclude a prior deterministic development sample",
    "  --exclude-sample <n>    size of the excluded development sample",
    "  --budget-tokens <n>    per-condition retrieval budget (default: 4096)",
    "  --max-passages <n>     per-condition passage cap (default: 8)",
    "  --output <path>        write compact diagnostic JSON",
    "  --dry-run              run diagnostics but never write a result file",
    "  --help                 show this text",
    "",
    "This runner makes zero model calls. Its metrics are selection diagnostics,",
    "not final answer/task-success scores.",
  ].join("\n");
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    data: join(here, "..", "third_party", "garage"),
    sample: 240,
    seed: "garage-selection-v1",
    retrievalBudget: 4_096,
    maxPassages: 8,
    output: null,
    dryRun: false,
    excludeSeed: null,
    excludeSample: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true };
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    const value = argv[++index];
    if (value == null) throw new Error(`${arg} requires a value`);
    if (arg === "--data") options.data = resolve(value);
    else if (arg === "--sample") options.sample = value === "all" ? Infinity : positiveInteger(value, arg);
    else if (arg === "--seed") options.seed = value;
    else if (arg === "--exclude-seed") options.excludeSeed = value;
    else if (arg === "--exclude-sample") options.excludeSample = positiveInteger(value, arg);
    else if (arg === "--budget-tokens") options.retrievalBudget = positiveInteger(value, arg);
    else if (arg === "--max-passages") options.maxPassages = positiveInteger(value, arg);
    else if (arg === "--output") options.output = resolve(value);
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

function compactCase(entry, selectionA, selectionB, diagnosticA, diagnosticB) {
  return {
    caseKey: entry.selectorView.caseKey,
    stratum: garageEvaluationStratum(entry),
    A: {
      citations: selectionA.selected.map((item) => item.citationId),
      sufficient: selectionA.sufficient,
      selectedTokens: diagnosticA.selectedTokens,
      assemblyMs: diagnosticA.assemblyMs,
      answerEvidenceFound: diagnosticA.answerEvidenceFound,
      predictedDeflect: diagnosticA.predictedDeflect,
    },
    B: {
      citations: selectionB.selected.map((item) => item.citationId),
      sufficient: selectionB.sufficient,
      selectedTokens: diagnosticB.selectedTokens,
      assemblyMs: diagnosticB.assemblyMs,
      answerEvidenceFound: diagnosticB.answerEvidenceFound,
      predictedDeflect: diagnosticB.predictedDeflect,
      conflicts: selectionB.conflicts,
    },
  };
}

function aggregateByStratum(rowsByCondition) {
  const result = {};
  for (const [stratum, rows] of [...rowsByCondition.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    result[stratum] = {
      A: aggregateGarageDiagnostics(rows.A),
      B: aggregateGarageDiagnostics(rows.B),
    };
    result[stratum].delta = summarizeGaragePair(result[stratum].A, result[stratum].B);
  }
  return result;
}

export async function runGarageSelectionDiagnostic(options) {
  const loaded = await loadGarageBench(options.data);
  if (Boolean(options.excludeSeed) !== Boolean(options.excludeSample)) {
    throw new Error("--exclude-seed and --exclude-sample must be provided together");
  }
  const excluded = options.excludeSeed
    ? fixedStratifiedGarageSample(loaded.cases, {
      seed: options.excludeSeed,
      size: Math.min(options.excludeSample, loaded.cases.length),
    })
    : [];
  const excludedKeys = new Set(excluded.map((entry) => entry.selectorView.caseKey));
  const eligible = loaded.cases.filter((entry) => !excludedKeys.has(entry.selectorView.caseKey));
  const sampleSize = options.sample === Infinity ? eligible.length : Math.min(options.sample, eligible.length);
  const sample = fixedStratifiedGarageSample(eligible, { seed: options.seed, size: sampleSize });
  const rowsA = [];
  const rowsB = [];
  const strata = new Map();
  const cases = [];
  for (const entry of sample) {
    // Only selectorView crosses either online selection boundary.
    const selectionA = selectWithProductionLocal(entry.selectorView, options);
    const selectionB = selectJudgmentEvidenceSet(entry.selectorView, options);
    const diagnosticA = diagnoseGarageSelection(entry.selectorView, entry.reference, selectionA);
    const diagnosticB = diagnoseGarageSelection(entry.selectorView, entry.reference, selectionB);
    rowsA.push(diagnosticA);
    rowsB.push(diagnosticB);
    const stratum = garageEvaluationStratum(entry);
    if (!strata.has(stratum)) strata.set(stratum, { A: [], B: [] });
    strata.get(stratum).A.push(diagnosticA);
    strata.get(stratum).B.push(diagnosticB);
    cases.push(compactCase(entry, selectionA, selectionB, diagnosticA, diagnosticB));
  }
  const conditionA = aggregateGarageDiagnostics(rowsA);
  const conditionB = aggregateGarageDiagnostics(rowsB);
  return {
    schemaVersion: 1,
    protocol: GARAGE_SELECTION_PROTOCOL,
    generatedAt: new Date().toISOString(),
    diagnosticOnly: true,
    modelCalls: 0,
    paidTokens: 0,
    warning: "This compares evidence selection only. It cannot be reported as final answer or task success.",
    taskSuccess: {
      status: "not-run",
      A: null,
      B: null,
      delta: null,
      requiredNextStep: "Run the same answer model and official-compatible judge on both frozen contexts.",
    },
    source: {
      file: loaded.sourceFile,
      bytes: loaded.sourceBytes,
      sha256: loaded.sourceSha256,
      officialQuestions: loaded.stats.questions,
      officialPassages: loaded.stats.passages,
    },
    sample: {
      ...garageSampleManifest(sample, { seed: options.seed }),
      excludedDevelopmentSample: excluded.length
        ? garageSampleManifest(excluded, { seed: options.excludeSeed })
        : null,
      overlapWithExcluded: sample.filter((entry) => excludedKeys.has(entry.selectorView.caseKey)).length,
    },
    parameters: {
      retrievalBudget: options.retrievalBudget,
      maxPassages: options.maxPassages,
      dryRun: options.dryRun,
    },
    conditions: { A: conditionA, B: conditionB },
    delta: summarizeGaragePair(conditionA, conditionB),
    strata: aggregateByStratum(strata),
    cases,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runGarageSelectionDiagnostic(options);
  const headline = {
    protocol: result.protocol,
    diagnosticOnly: true,
    modelCalls: 0,
    sample: result.sample,
    A: result.conditions.A,
    B: result.conditions.B,
    delta: result.delta,
  };
  process.stdout.write(`${JSON.stringify(headline, null, 2)}\n`);
  if (options.output && !options.dryRun) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stderr.write(`Wrote ${options.output}\n`);
  } else if (options.output && options.dryRun) {
    process.stderr.write(`Dry run: did not write ${options.output}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
