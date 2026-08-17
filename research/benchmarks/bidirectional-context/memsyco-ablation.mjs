import { compileBidirectionalContext } from "./compiler.mjs";
import { assertNoMemSycoGoldLeak } from "../memsyco/adapter.mjs";
import { selectedVerbatimTurns } from "./local-ablation-protocol.mjs";

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function memSycoHistoryMessages(selectorView) {
  assertNoMemSycoGoldLeak(selectorView);
  return selectorView.history.map((turn, index) => ({
    role: turn.role,
    content: turn.content,
    entryId: turn.turnId,
    parentEntryId: index ? selectorView.history[index - 1].turnId : null,
    sessionId: selectorView.caseKey,
    entryTimestamp: null,
    timestamp: null,
  }));
}

export function compileMemSycoAblationCase(item, {
  condition,
  budget,
  liveBlocks = 1,
} = {}) {
  assertNoMemSycoGoldLeak(item.selectorView);
  const messages = memSycoHistoryMessages(item.selectorView);
  const result = compileBidirectionalContext({
    messages,
    query: item.selectorView.question,
    condition,
    budget,
    liveBlocks,
  });
  if (result.overflow) return { caseKey: item.selectorView.caseKey, condition, budget, ...result };
  selectedVerbatimTurns(item.selectorView, result);
  const conditionLeak = /positive-only|gc-only|bidirectional(?:-heat|-luna)?/i.test(result.context);
  if (conditionLeak) throw new Error(`${item.selectorView.caseKey} leaked an experimental condition into answer context`);
  return {
    caseKey: item.selectorView.caseKey,
    condition,
    budget,
    overflow: false,
    context: result.context,
    contextTokens: result.contextTokens,
    assemblyMs: result.assemblyMs,
    selectedCount: result.selectedBlocks.length,
    retainedKeep: result.manifest.retained.filter((row) => row.state === "KEEP").length,
    retainedUnknown: result.manifest.retained.filter((row) => row.state === "UNKNOWN").length,
    droppedCount: result.manifest.dropped.length,
    deferredCount: result.manifest.deferred.length,
    outputHash: result.manifest.outputHash,
    manifest: result.manifest,
  };
}

export function summarizeAssemblyRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.condition}\0${row.budget}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, values]) => {
    const [condition, budgetText] = key.split("\0");
    const completed = values.filter((row) => !row.overflow);
    const tokens = completed.map((row) => row.contextTokens);
    const latency = completed.map((row) => row.assemblyMs);
    return {
      condition,
      budget: Number(budgetText),
      cases: values.length,
      overflow: values.length - completed.length,
      contextTokens: { mean: mean(tokens), p50: quantile(tokens, 0.5), p95: quantile(tokens, 0.95), max: tokens.length ? Math.max(...tokens) : null },
      assemblyMs: { mean: mean(latency), p50: quantile(latency, 0.5), p95: quantile(latency, 0.95), max: latency.length ? Math.max(...latency) : null },
      selectedCountMean: mean(completed.map((row) => row.selectedCount)),
      retainedKeepMean: mean(completed.map((row) => row.retainedKeep)),
      retainedUnknownMean: mean(completed.map((row) => row.retainedUnknown)),
      droppedCountMean: mean(completed.map((row) => row.droppedCount)),
      deferredCountMean: mean(completed.map((row) => row.deferredCount)),
      taskSuccess: null,
      falseDropRate: null,
      note: "Assembly-only. MemSyco does not release gold supporting turn IDs; task success requires the frozen answer+judge run.",
    };
  }).sort((a, b) => a.budget - b.budget || a.condition.localeCompare(b.condition));
}

export function runMemSycoAssemblyAblation(cases, {
  conditions = ["positive-only", "gc-only", "bidirectional", "bidirectional-heat"],
  budgets = [512, 1024, 2048],
  liveBlocks = 1,
} = {}) {
  const rows = [];
  for (const item of cases) {
    for (const budget of budgets) {
      for (const condition of conditions) {
        rows.push(compileMemSycoAblationCase(item, {
          condition,
          budget,
          liveBlocks,
        }));
      }
    }
  }
  return { rows, summary: summarizeAssemblyRows(rows) };
}
