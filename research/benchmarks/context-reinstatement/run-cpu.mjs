import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBidirectionalContext, EVIDENCE_CONTEXT_COMPILER_VERSION } from "../../../pi-idea-extension/src/evidence-context-compiler.js";

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(fraction * ordered.length) - 1));
  return ordered[index];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function makeCurrentCase(index) {
  const current = {
    role: "user",
    id: `current-${index}`,
    content: `CASE-${index} ALPHA measurement is ${9000 + index}.`,
    researchIdeaHash: "idea-current",
    researchStageHash: "stage-current",
  };
  const distractor = {
    role: "user",
    id: `distractor-${index}`,
    content: `CASE-${index} ALPHA measurement is ${3000 + index}.`,
    researchIdeaHash: index % 3 === 0 ? "idea-old" : "idea-current",
    researchStageHash: "stage-old",
  };
  // Half of the cases put stale evidence later. A recency tie-breaker therefore
  // cannot solve the suite, while the event's research-state coordinates can.
  const messages = index % 2 === 0 ? [current, distractor] : [distractor, current];
  return {
    id: `current-${index}`,
    kind: "current",
    query: `What is the CASE-${index} ALPHA measurement?`,
    messages,
    expected: current.content,
    distractor: distractor.content,
  };
}

function makeHistoricalCase(index) {
  const historical = {
    role: "user",
    id: `historical-${index}`,
    content: `CASE-H${index} legacy-marker-${index} ALPHA measurement is ${4000 + index}.`,
    researchIdeaHash: "idea-current",
    researchStageHash: "stage-old",
  };
  const current = {
    role: "user",
    id: `historical-current-${index}`,
    content: `CASE-H${index} ALPHA measurement is ${8000 + index}.`,
    researchIdeaHash: "idea-current",
    researchStageHash: "stage-current",
  };
  return {
    id: `historical-${index}`,
    kind: "historical",
    query: `What was the previous CASE-H${index} ALPHA measurement at legacy-marker-${index}?`,
    messages: [historical, current],
    expected: historical.content,
    distractor: current.content,
  };
}

function runCondition(testCase, contextual) {
  const result = compileBidirectionalContext({
    messages: testCase.messages,
    query: testCase.query,
    condition: "bidirectional",
    budget: 256,
    liveBlocks: 0,
    maxPositiveKeeps: 1,
    maxOptionalKeeps: 0,
    activeContext: contextual ? { ideaHash: "idea-current", stageHash: "stage-current" } : null,
  });
  const selected = result.selectedBlocks.map((block) => block.raw);
  return {
    correct: selected.includes(testCase.expected),
    distractorAt1: selected[0] === testCase.distractor,
    selected,
    contextTokens: result.contextTokens || 0,
    assemblyMs: result.assemblyMs,
    recallFrame: result.manifest?.recallFrame || null,
  };
}

const cases = [
  ...Array.from({ length: 60 }, (_, index) => makeCurrentCase(index + 1)),
  ...Array.from({ length: 20 }, (_, index) => makeHistoricalCase(index + 1)),
];
const rows = cases.map((testCase) => ({
  id: testCase.id,
  kind: testCase.kind,
  lexical: runCondition(testCase, false),
  contextual: runCondition(testCase, true),
}));

function summarize(condition, kind) {
  const subset = rows.filter((row) => row.kind === kind).map((row) => row[condition]);
  return {
    cases: subset.length,
    selectionAccuracy: subset.filter((row) => row.correct).length / subset.length,
    contextDistractorAt1: subset.filter((row) => row.distractorAt1).length / subset.length,
    meanContextTokens: mean(subset.map((row) => row.contextTokens)),
    p95AssemblyMs: percentile(subset.map((row) => row.assemblyMs), 0.95),
  };
}

const report = {
  schema: 1,
  benchmark: "pi-idea-context-reinstatement-cpu-v1",
  generatedAt: new Date().toISOString(),
  datasetHash: sha256(JSON.stringify(cases)),
  compilerVersion: EVIDENCE_CONTEXT_COMPILER_VERSION,
  modelCalls: 0,
  gpuUsed: false,
  cases: cases.length,
  scope: "Synthetic retrieval/context-validity diagnostic; not an end-to-end model task-performance result.",
  results: {
    lexical: {
      current: summarize("lexical", "current"),
      historical: summarize("lexical", "historical"),
    },
    contextual: {
      current: summarize("contextual", "current"),
      historical: summarize("contextual", "historical"),
    },
  },
  rows,
};

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "results", "context-reinstatement-cpu-20260813.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, ...report.results }, null, 2));
