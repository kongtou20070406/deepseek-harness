import { createHash } from "node:crypto";

const CLASSES = Object.freeze([
  "ANSWER-THE-QUESTION",
  "RELATED-INFORMATION",
  "OUTDATED",
  "UNKNOWN",
  "UNLABELED",
]);

function safeDivide(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function normalizedClass(value) {
  return value || "UNLABELED";
}

function selectedByCitation(selection) {
  const result = new Map();
  for (const item of selection.selected || []) {
    if (result.has(item.citationId)) throw new Error(`Duplicate selected citation ${item.citationId}`);
    result.set(item.citationId, item);
  }
  return result;
}

/** Gold is joined only after a selector has returned its closed-view result. */
export function diagnoseGarageSelection(selectorView, reference, selection) {
  if (selectorView.caseKey !== reference.caseKey) throw new Error("GaRAGe selector/reference case mismatch");
  const selected = selectedByCitation(selection);
  const passageIds = new Set(selectorView.passages.map((passage) => passage.passageId));
  for (const item of selected.values()) {
    if (!passageIds.has(item.passageId)) throw new Error(`Selector returned passage outside online view: ${item.passageId}`);
  }
  const counts = Object.fromEntries(CLASSES.map((label) => [label, { available: 0, selected: 0, selectedTokens: 0 }]));
  for (const judgment of reference.passageJudgments) {
    const label = normalizedClass(judgment.correct);
    if (!counts[label]) throw new Error(`Unsupported GaRAGe evidence class ${label}`);
    counts[label].available += 1;
    const item = selected.get(judgment.citationId);
    if (!item) continue;
    counts[label].selected += 1;
    counts[label].selectedTokens += item.tokens || 0;
  }
  const selectedCount = [...selected.values()].length;
  const selectedTokens = [...selected.values()].reduce((total, item) => total + (item.tokens || 0), 0);
  const classMetrics = Object.fromEntries(CLASSES.map((label) => [label, {
    ...counts[label],
    precision: safeDivide(counts[label].selected, selectedCount),
    recall: safeDivide(counts[label].selected, counts[label].available),
    tokenShare: safeDivide(counts[label].selectedTokens, selectedTokens),
  }]));
  const answerAvailable = counts["ANSWER-THE-QUESTION"].available > 0;
  const answerEvidenceFound = counts["ANSWER-THE-QUESTION"].selected > 0;
  const shouldDeflect = !answerAvailable;
  const predictedDeflect = !selection.sufficient;
  return {
    caseKey: selectorView.caseKey,
    condition: selection.condition,
    selectedCount,
    selectedTokens,
    assemblyMs: selection.metrics?.assemblyMs || 0,
    classMetrics,
    answerAvailable,
    answerEvidenceFound,
    shouldDeflect,
    predictedDeflect,
    deflectionReady: shouldDeflect ? predictedDeflect : null,
    falseDeflection: answerAvailable ? predictedDeflect : null,
    offlineReadinessHit: answerAvailable ? answerEvidenceFound && !predictedDeflect : predictedDeflect,
    // This is evidence-selection readiness, not an answer or task-success score.
    diagnosticOnly: true,
  };
}

export function aggregateGarageDiagnostics(rows) {
  const totals = Object.fromEntries(CLASSES.map((label) => [label, { available: 0, selected: 0, selectedTokens: 0 }]));
  let selectedCount = 0;
  let selectedTokens = 0;
  for (const row of rows) {
    selectedCount += row.selectedCount;
    selectedTokens += row.selectedTokens;
    for (const label of CLASSES) {
      totals[label].available += row.classMetrics[label].available;
      totals[label].selected += row.classMetrics[label].selected;
      totals[label].selectedTokens += row.classMetrics[label].selectedTokens;
    }
  }
  const answerable = rows.filter((row) => row.answerAvailable);
  const deflection = rows.filter((row) => row.shouldDeflect);
  const result = {
    cases: rows.length,
    selectedPassages: selectedCount,
    totalSelectedTokens: selectedTokens,
    meanSelectedPassages: safeDivide(selectedCount, rows.length),
    meanSelectedTokens: safeDivide(selectedTokens, rows.length),
    meanAssemblyMs: mean(rows.map((row) => row.assemblyMs)),
    p95AssemblyMs: percentile(rows.map((row) => row.assemblyMs), 0.95),
    evidenceAvailabilityRate: safeDivide(answerable.filter((row) => row.answerEvidenceFound).length, answerable.length),
    deflectionReadinessRate: safeDivide(deflection.filter((row) => row.predictedDeflect).length, deflection.length),
    falseDeflectionRate: safeDivide(answerable.filter((row) => row.predictedDeflect).length, answerable.length),
    offlineSelectionReadinessRate: safeDivide(rows.filter((row) => row.offlineReadinessHit).length, rows.length),
    classes: {},
    diagnosticOnly: true,
    taskSuccess: null,
  };
  for (const label of CLASSES) {
    result.classes[label] = {
      ...totals[label],
      precision: safeDivide(totals[label].selected, selectedCount),
      recall: safeDivide(totals[label].selected, totals[label].available),
      tokenShare: safeDivide(totals[label].selectedTokens, selectedTokens),
    };
  }
  return result;
}

export function stableCaseOrder(caseKey, seed) {
  return createHash("sha256").update(`${seed}\0${caseKey}`).digest("hex");
}

export function garageEvaluationStratum(entry) {
  const labels = new Set(entry.reference.eligibilityLabels);
  const answerState = labels.has("insufficient-grounding")
    ? "insufficient"
    : labels.has("relevant-only-grounding")
      ? "relevant-only"
      : labels.has("contains-outdated")
        ? "answerable-outdated"
        : "answerable-current";
  return `${answerState}|${labels.has("time-sensitive") ? "time-sensitive" : "not-time-sensitive"}`;
}

/** Stratification is post-hoc protocol design; references never reach selectors. */
export function fixedStratifiedGarageSample(cases, { seed = "garage-selection-v1", size = 240 } = {}) {
  if (!Number.isInteger(size) || size <= 0) throw new TypeError("sample size must be a positive integer");
  if (size >= cases.length) return [...cases].sort((left, right) => stableCaseOrder(left.selectorView.caseKey, seed).localeCompare(stableCaseOrder(right.selectorView.caseKey, seed)));
  const buckets = new Map();
  for (const entry of cases) {
    const stratum = garageEvaluationStratum(entry);
    if (!buckets.has(stratum)) buckets.set(stratum, []);
    buckets.get(stratum).push(entry);
  }
  for (const entries of buckets.values()) {
    entries.sort((left, right) => stableCaseOrder(left.selectorView.caseKey, seed).localeCompare(stableCaseOrder(right.selectorView.caseKey, seed)));
  }
  const names = [...buckets.keys()].sort();
  const selected = [];
  let round = 0;
  while (selected.length < size) {
    let progressed = false;
    for (const name of names) {
      const entry = buckets.get(name)[round];
      if (!entry) continue;
      selected.push(entry);
      progressed = true;
      if (selected.length === size) break;
    }
    if (!progressed) break;
    round += 1;
  }
  return selected;
}

export function garageSampleManifest(sample, { seed }) {
  const strata = {};
  const keys = sample.map((entry) => entry.selectorView.caseKey);
  for (const entry of sample) {
    const stratum = garageEvaluationStratum(entry);
    strata[stratum] = (strata[stratum] || 0) + 1;
  }
  return {
    seed,
    size: sample.length,
    sha256: `sha256:${createHash("sha256").update(keys.join("\n")).digest("hex")}`,
    strata: Object.fromEntries(Object.entries(strata).sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function summarizeGaragePair(conditionA, conditionB) {
  return {
    selectedTokenDelta: conditionB.meanSelectedTokens - conditionA.meanSelectedTokens,
    assemblyP95DeltaMs: conditionB.p95AssemblyMs - conditionA.p95AssemblyMs,
    answerEvidenceAvailabilityDelta: conditionB.evidenceAvailabilityRate - conditionA.evidenceAvailabilityRate,
    deflectionReadinessDelta: conditionB.deflectionReadinessRate - conditionA.deflectionReadinessRate,
    offlineSelectionReadinessDelta: conditionB.offlineSelectionReadinessRate - conditionA.offlineSelectionReadinessRate,
    taskSuccessDelta: null,
    warning: "Offline evidence-selection diagnostics are not final answer/task success.",
  };
}
