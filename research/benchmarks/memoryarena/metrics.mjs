import { normalizeCondition } from "./protocol.mjs";

const TOKEN_FIELDS = Object.freeze([
  "mainInputTokens",
  "mainOutputTokens",
  "injectedContextTokens",
  "lunaInputTokens",
  "lunaOutputTokens",
]);

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function quantileLinear(values, probability) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("quantile probability must be in [0, 1]");
  }
  const sorted = values.map(Number).sort((a, b) => a - b);
  if (sorted.some((value) => !Number.isFinite(value))) {
    throw new TypeError("quantile values must be finite numbers");
  }
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function normalizeTokenUsage(value = {}) {
  const normalized = {};
  for (const field of TOKEN_FIELDS) {
    const count = Number(value[field] ?? 0);
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError(`tokenUsage.${field} must be a non-negative integer`);
    }
    normalized[field] = count;
  }
  normalized.totalModelTokens =
    normalized.mainInputTokens +
    normalized.mainOutputTokens +
    normalized.lunaInputTokens +
    normalized.lunaOutputTokens;
  return normalized;
}

function normalizeLoopMetrics(value = []) {
  if (!Array.isArray(value)) throw new TypeError("loopMetrics must be an array");
  return value.map((sample, index) => {
    if (!sample || typeof sample !== "object") {
      throw new TypeError(`loopMetrics[${index}] must be an object`);
    }
    const assemblyMs = Number(sample.assemblyMs);
    if (!Number.isFinite(assemblyMs) || assemblyMs < 0) {
      throw new TypeError(`loopMetrics[${index}].assemblyMs must be non-negative and finite`);
    }
    const injectedContextTokens = Number(sample.injectedContextTokens ?? 0);
    if (!Number.isInteger(injectedContextTokens) || injectedContextTokens < 0) {
      throw new TypeError(
        `loopMetrics[${index}].injectedContextTokens must be a non-negative integer`,
      );
    }
    return {
      sessionId: sample.sessionId ?? null,
      loopOrdinal: sample.loopOrdinal ?? index + 1,
      assemblyMs,
      injectedContextTokens,
    };
  });
}

function assertReference(reference) {
  if (!reference || typeof reference !== "object") throw new TypeError("reference is required");
  if (!Array.isArray(reference.goldAnswers) || reference.goldAnswers.length < 2) {
    throw new TypeError("reference.goldAnswers must contain ordered subtasks");
  }
  if (!new Set(["all-subtasks", "final-subtask"]).has(reference.successRule)) {
    throw new Error(`Unsupported MemoryArena success rule: ${reference.successRule}`);
  }
}

export function scoreMemoryArenaRun(run, reference) {
  assertReference(reference);
  if (!run || typeof run !== "object") throw new TypeError("run is required");
  if (run.caseKey !== reference.caseKey) throw new Error("run/reference caseKey mismatch");
  if (run.config !== reference.config) throw new Error("run/reference config mismatch");
  const condition = normalizeCondition(run.condition);
  if (!Array.isArray(run.subtaskResults)) {
    throw new TypeError("run.subtaskResults must be an array");
  }
  if (run.subtaskResults.length !== reference.goldAnswers.length) {
    throw new Error(
      `Subtask result count ${run.subtaskResults.length} does not match ` +
        `reference count ${reference.goldAnswers.length}`,
    );
  }

  const subtaskResults = run.subtaskResults.map((result, index) => {
    if (!result || typeof result !== "object" || typeof result.passed !== "boolean") {
      throw new TypeError(`subtaskResults[${index}].passed must be boolean`);
    }
    if (result.sessionOrdinal !== undefined && result.sessionOrdinal !== index + 1) {
      throw new Error(`subtaskResults[${index}] has a non-sequential sessionOrdinal`);
    }
    let softProgress = null;
    if (result.softProgress !== undefined && result.softProgress !== null) {
      softProgress = Number(result.softProgress);
      if (!Number.isFinite(softProgress) || softProgress < 0 || softProgress > 1) {
        throw new RangeError(`subtaskResults[${index}].softProgress must be in [0, 1]`);
      }
    }
    return { sessionOrdinal: index + 1, passed: result.passed, softProgress };
  });

  const passedCount = subtaskResults.filter((result) => result.passed).length;
  const taskProgress = passedCount / subtaskResults.length;
  const computedTaskSuccess =
    reference.successRule === "all-subtasks"
      ? passedCount === subtaskResults.length
      : subtaskResults.at(-1).passed;
  if (run.taskSuccess !== undefined && Boolean(run.taskSuccess) !== computedTaskSuccess) {
    throw new Error(
      `Provided taskSuccess disagrees with MemoryArena ${reference.successRule} rule`,
    );
  }

  const softValues = subtaskResults.map((result) => result.softProgress);
  const softProgress =
    reference.config === "group_travel_planner" && softValues.every((value) => value !== null)
      ? mean(softValues)
      : null;
  const tokenUsage = normalizeTokenUsage(run.tokenUsage);
  const loopMetrics = normalizeLoopMetrics(run.loopMetrics);

  return {
    caseKey: run.caseKey,
    config: run.config,
    condition,
    resultClass: run.resultClass ?? "unverified",
    taskSuccess: computedTaskSuccess,
    taskProgress,
    softProgress,
    passedSubtasks: passedCount,
    totalSubtasks: subtaskResults.length,
    tokenUsage,
    loopMetrics,
    comparability: run.comparability ?? {},
  };
}

function aggregateScored(scored, { includeByConfig = true } = {}) {
  if (scored.length === 0) throw new Error("Cannot aggregate zero MemoryArena runs");
  const requestedConditions = [...new Set(scored.map((item) => item.condition.requested))];
  if (requestedConditions.length !== 1) {
    throw new Error("Aggregate input must have exactly one requested condition");
  }
  const effectiveConditionCounts = { local: 0, luna: 0 };
  for (const item of scored) effectiveConditionCounts[item.condition.effective] += 1;

  const tokenTotals = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  let totalModelTokens = 0;
  const assemblySamples = [];
  for (const item of scored) {
    for (const field of TOKEN_FIELDS) tokenTotals[field] += item.tokenUsage[field];
    totalModelTokens += item.tokenUsage.totalModelTokens;
    for (const sample of item.loopMetrics) assemblySamples.push(sample.assemblyMs);
  }
  tokenTotals.totalModelTokens = totalModelTokens;

  const report = {
    schemaVersion: 1,
    benchmark: "MemoryArena",
    requestedCondition: requestedConditions[0],
    taskCount: scored.length,
    taskSuccessRate: mean(scored.map((item) => (item.taskSuccess ? 1 : 0))),
    taskProgressScore: mean(scored.map((item) => item.taskProgress)),
    softProgressScore:
      scored.some((item) => item.softProgress !== null)
        ? mean(scored.filter((item) => item.softProgress !== null).map((item) => item.softProgress))
        : null,
    tokens: {
      totals: tokenTotals,
      perTaskMean: Object.fromEntries(
        Object.entries(tokenTotals).map(([field, total]) => [field, total / scored.length]),
      ),
    },
    assemblyLatency: {
      sampleCount: assemblySamples.length,
      p50Ms: quantileLinear(assemblySamples, 0.5),
      p95Ms: quantileLinear(assemblySamples, 0.95),
      maxMs: assemblySamples.length ? Math.max(...assemblySamples) : null,
    },
    fallback: {
      count: scored.filter((item) => item.condition.fellBack).length,
      rate: mean(scored.map((item) => (item.condition.fellBack ? 1 : 0))),
      effectiveConditionCounts,
    },
    resultClasses: Object.fromEntries(
      [...new Set(scored.map((item) => item.resultClass))].map((kind) => [
        kind,
        scored.filter((item) => item.resultClass === kind).length,
      ]),
    ),
  };

  if (includeByConfig) {
    report.byConfig = {};
    for (const config of [...new Set(scored.map((item) => item.config))].sort()) {
      report.byConfig[config] = aggregateScored(
        scored.filter((item) => item.config === config),
        { includeByConfig: false },
      );
    }
  }
  return report;
}

export function aggregateMemoryArenaRuns(runs, referencesByCaseKey) {
  if (!(referencesByCaseKey instanceof Map)) {
    throw new TypeError("referencesByCaseKey must be a Map held by the evaluator");
  }
  const scored = runs.map((run) => {
    const reference = referencesByCaseKey.get(run.caseKey);
    if (!reference) throw new Error(`Missing judge-only reference for ${run.caseKey}`);
    return scoreMemoryArenaRun(run, reference);
  });
  return aggregateScored(scored);
}

function comparablePair(localRun, lunaRun) {
  const fields = ["agentModel", "judgeVersion", "seed", "maxSteps"];
  for (const field of fields) {
    const local = localRun.comparability?.[field] ?? null;
    const luna = lunaRun.comparability?.[field] ?? null;
    if (JSON.stringify(local) !== JSON.stringify(luna)) {
      throw new Error(`Paired runs disagree on comparability.${field} for ${localRun.caseKey}`);
    }
  }
}

function deltaReport(local, luna) {
  const localMinusLunaPp = (local.taskSuccessRate - luna.taskSuccessRate) * 100;
  return {
    localMinusLunaTaskSuccessPp: localMinusLunaPp,
    localWithinTenPercentagePoints: localMinusLunaPp >= -10,
    localMinusLunaProgress: local.taskProgressScore - luna.taskProgressScore,
    localMinusLunaInjectedContextTokens:
      local.tokens.totals.injectedContextTokens - luna.tokens.totals.injectedContextTokens,
    localMinusLunaTotalModelTokens:
      local.tokens.totals.totalModelTokens - luna.tokens.totals.totalModelTokens,
    localMinusLunaAssemblyP95Ms:
      local.assemblyLatency.p95Ms === null || luna.assemblyLatency.p95Ms === null
        ? null
        : local.assemblyLatency.p95Ms - luna.assemblyLatency.p95Ms,
  };
}

export function comparePairedMemoryArenaRuns(localRuns, lunaRuns, referencesByCaseKey) {
  const localByKey = new Map(localRuns.map((run) => [run.caseKey, run]));
  const lunaByKey = new Map(lunaRuns.map((run) => [run.caseKey, run]));
  const localKeys = [...localByKey.keys()].sort();
  const lunaKeys = [...lunaByKey.keys()].sort();
  if (JSON.stringify(localKeys) !== JSON.stringify(lunaKeys)) {
    throw new Error("Local and Luna conditions must contain exactly the same case keys");
  }
  for (const caseKey of localKeys) comparablePair(localByKey.get(caseKey), lunaByKey.get(caseKey));

  const localRequested = aggregateMemoryArenaRuns(localRuns, referencesByCaseKey);
  const lunaRequested = aggregateMemoryArenaRuns(lunaRuns, referencesByCaseKey);
  const strictKeys = localKeys.filter(
    (caseKey) =>
      normalizeCondition(localByKey.get(caseKey).condition).effective === "local" &&
      normalizeCondition(lunaByKey.get(caseKey).condition).effective === "luna",
  );
  const excludedFallbackCaseKeys = localKeys.filter((caseKey) => !strictKeys.includes(caseKey));

  let strict = null;
  if (strictKeys.length > 0) {
    const strictLocal = aggregateMemoryArenaRuns(
      strictKeys.map((key) => localByKey.get(key)),
      referencesByCaseKey,
    );
    const strictLuna = aggregateMemoryArenaRuns(
      strictKeys.map((key) => lunaByKey.get(key)),
      referencesByCaseKey,
    );
    strict = {
      local: strictLocal,
      luna: strictLuna,
      delta: deltaReport(strictLocal, strictLuna),
    };
  }

  return {
    schemaVersion: 1,
    benchmark: "MemoryArena",
    pairedCaseCount: localKeys.length,
    strictPairedCaseCount: strictKeys.length,
    excludedFallbackCaseKeys,
    requested: {
      local: localRequested,
      luna: lunaRequested,
    },
    strict,
  };
}
