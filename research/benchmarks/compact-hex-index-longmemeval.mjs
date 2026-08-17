import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadLongMemEval, splitLongMemEval, stratifiedSample, selectorViewToPiMessages } from "./longmemeval/adapter.mjs";
import { compileContext, groupTurns, makeFoldUnits } from "../../pi-idea-extension/src/context-compiler.js";
import { CompactHexIndex } from "./compact-hex-index.mjs";

const root = resolve(import.meta.dirname, "../..");
const dataPath = resolve(root, "research/benchmarks/third_party/longmemeval/longmemeval_s_cleaned.json");
const cacheDir = resolve(root, "research/benchmarks/longmemeval/.cache");

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const cache = new Map();
for (const name of await readdir(cacheDir)) {
  if (!name.startsWith("tag-") || !name.endsWith(".json")) continue;
  try {
    const row = JSON.parse(await readFile(resolve(cacheDir, name), "utf8"));
    if (row?.id && Array.isArray(row.claims)) cache.set(row.id, row);
  } catch {}
}

const { rows } = await loadLongMemEval(dataPath);
const { publicCases, references } = splitLongMemEval(rows);
const sample = stratifiedSample(publicCases, 60);
const buildMs = [], queryMs = [], baselineMs = [], postingVisits = [], candidateCounts = [], skippedHighFrequency = [];
let ready = 0, recallNumerator = 0, recallDenominator = 0, anyHit = 0;
let baselineRecallNumerator = 0, baselineAnyHit = 0;
let documents = 0, labels = 0, postingIds = 0;
let maxDocuments = 0, maxLabels = 0, maxPostingIds = 0;
const byType = new Map();

for (const item of sample) {
  const messages = selectorViewToPiMessages(item.selectorView);
  const turns = groupTurns(messages);
  const cold = turns.slice(0, Math.max(0, turns.length - 4));
  const units = makeFoldUnits(cold).filter((unit) => unit.stable).map((unit) => ({ ...unit, record: cache.get(unit.id) }));
  if (!units.length || units.some((unit) => !unit.record)) continue;
  ready += 1;
  const index = new CompactHexIndex();
  for (const unit of units) buildMs.push(index.addRecord(unit.record).ms);
  const stats = index.stats();
  documents += stats.documents; labels += stats.labels; postingIds += stats.postingIds;
  maxDocuments = Math.max(maxDocuments, stats.documents);
  maxLabels = Math.max(maxLabels, stats.labels);
  maxPostingIds = Math.max(maxPostingIds, stats.postingIds);
  const found = index.query(item.selectorView.question, { limit: 8 });
  queryMs.push(found.ms);
  postingVisits.push(found.postingVisits);
  candidateCounts.push(found.candidates);
  skippedHighFrequency.push(found.skippedHighFrequency);

  const baselineStart = performance.now();
  const baseline = compileContext({ messages, prompt: item.selectorView.question, summaries: cache, liveTurns: 4,
    strictEvidenceIndex: true, retrievalBudget: 12000, maxRetrievedUnits: 8 });
  baselineMs.push(performance.now() - baselineStart);

  const expected = new Set(references.get(item.caseKey).evidenceSessionIds);
  const selected = new Set(found.rows.map((row) => row.memorySessionId).filter(Boolean));
  let hits = 0;
  for (const id of expected) if (selected.has(id)) hits += 1;
  if (expected.size) {
    recallNumerator += hits;
    recallDenominator += expected.size;
    if (hits) anyHit += 1;
    const baselineSelected = new Set((baseline.selectedClaims || []).map((row) => row.memorySessionId).filter(Boolean));
    let baselineHits = 0;
    for (const id of expected) if (baselineSelected.has(id)) baselineHits += 1;
    baselineRecallNumerator += baselineHits;
    if (baselineHits) baselineAnyHit += 1;
    const type = byType.get(item.questionType) || { questions: 0, evidence: 0, hexHits: 0, baselineHits: 0 };
    type.questions += 1;
    type.evidence += expected.size;
    type.hexHits += hits;
    type.baselineHits += baselineHits;
    byType.set(item.questionType, type);
  }
}

console.log(JSON.stringify({
  sample: sample.length,
  fullyIndexedCases: ready,
  evidenceSessionRecall: recallDenominator ? recallNumerator / recallDenominator : null,
  anyEvidenceHitRate: recallDenominator ? anyHit / ready : null,
  currentSelectorEvidenceSessionRecall: recallDenominator ? baselineRecallNumerator / recallDenominator : null,
  currentSelectorAnyEvidenceHitRate: recallDenominator ? baselineAnyHit / ready : null,
  perBlockBuildMs: { median: percentile(buildMs, .5), p95: percentile(buildMs, .95), max: Math.max(...buildMs, 0) },
  hexQueryMs: { median: percentile(queryMs, .5), p95: percentile(queryMs, .95), max: Math.max(...queryMs, 0) },
  queryWork: {
    postingVisits: { median: percentile(postingVisits, .5), p95: percentile(postingVisits, .95), max: Math.max(...postingVisits, 0) },
    candidates: { median: percentile(candidateCounts, .5), p95: percentile(candidateCounts, .95), max: Math.max(...candidateCounts, 0) },
    skippedHighFrequencyLabels: { median: percentile(skippedHighFrequency, .5), p95: percentile(skippedHighFrequency, .95), max: Math.max(...skippedHighFrequency, 0) },
  },
  currentFullCompileMs: { median: percentile(baselineMs, .5), p95: percentile(baselineMs, .95), max: Math.max(...baselineMs, 0) },
  summedAcrossCases: { documents, labels, postingIds },
  largestSingleCase: { documents: maxDocuments, labels: maxLabels, postingIds: maxPostingIds },
  byType: Object.fromEntries([...byType].map(([type, row]) => [type, {
    ...row,
    hexRecall: row.evidence ? row.hexHits / row.evidence : null,
    currentSelectorRecall: row.evidence ? row.baselineHits / row.evidence : null,
  }])),
}, null, 2));
