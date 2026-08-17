const RANK = Object.freeze({ low: 0, medium: 1, high: 2, max: 3 });
const LEVELS = Object.freeze(["low", "medium", "high", "max"]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

/**
 * Deterministic Luna effort routing. Duration alone does not force max: a long
 * divisible scan is chunked into bounded low-effort tasks, while a short but
 * dependency-heavy or high-risk task can route high/max.
 */
export function routeWorkflowEffort({
  expectedMinutes = 5,
  stepCount = 1,
  dependencyDepth = 0,
  ambiguity = 0,
  risk = 0,
  scientificJudgment = 0,
  mechanicallyDivisible = false,
  estimatedInputTokens = 0,
} = {}) {
  const minutes = Math.max(0, finite(expectedMinutes, 5));
  const steps = Math.max(1, Math.round(finite(stepCount, 1)));
  const depth = Math.max(0, Math.round(finite(dependencyDepth, 0)));
  const normalizedAmbiguity = clamp(finite(ambiguity), 0, 1);
  const normalizedRisk = clamp(finite(risk), 0, 1);
  const judgment = clamp(finite(scientificJudgment), 0, 1);
  const tokens = Math.max(0, finite(estimatedInputTokens));

  let score = 0;
  if (minutes > 10) score += 1;
  if (minutes > 45) score += 1;
  if (minutes > 120) score += 1;
  if (steps >= 5) score += 1;
  if (steps >= 12) score += 1;
  if (depth >= 2) score += 1;
  if (depth >= 5) score += 1;
  if (normalizedAmbiguity >= 0.35) score += 1;
  if (normalizedAmbiguity >= 0.7) score += 1;
  if (normalizedRisk >= 0.4) score += 1;
  if (normalizedRisk >= 0.75) score += 1;
  if (judgment >= 0.25) score += 1;
  if (judgment >= 0.6) score += 2;
  if (tokens >= 32_000) score += 1;
  if (tokens >= 120_000) score += 1;

  let level = score <= 1 ? "low" : score <= 3 ? "medium" : score <= 6 ? "high" : "max";
  const reasons = [];
  let chunk = null;
  if (mechanicallyDivisible && judgment < 0.25 && normalizedAmbiguity < 0.35 && normalizedRisk < 0.4) {
    const longMechanical = minutes > 20 || steps > 8 || tokens > 32_000;
    if (longMechanical) {
      level = "low";
      const chunks = Math.max(2, Math.ceil(Math.max(minutes / 20, steps / 6, tokens / 24_000)));
      chunk = Object.freeze({
        recommended: true,
        chunks,
        maxMinutesPerChunk: 20,
        maxStepsPerChunk: 6,
        maxInputTokensPerChunk: 24_000,
        barrier: "aggregate-result-evidence-delta-before-next-stage",
      });
      reasons.push("long-mechanical-task-is-divisible");
    }
  }
  if (!chunk) {
    if (minutes > 45) reasons.push("long-duration");
    if (depth >= 2) reasons.push("dependency-depth");
    if (normalizedAmbiguity >= 0.35) reasons.push("ambiguity");
    if (normalizedRisk >= 0.4) reasons.push("risk");
    if (judgment >= 0.25) reasons.push("scientific-judgment");
    if (tokens >= 32_000) reasons.push("large-input");
    if (!reasons.length) reasons.push("short-bounded-mechanical-task");
  }
  return Object.freeze({
    model: "gpt-5.6-luna",
    reasoningEffort: level,
    initialReasoningEffort: level,
    score,
    reasons: Object.freeze(reasons),
    chunk,
    escalationPolicy: Object.freeze({
      trigger: "two-consecutive-same-class-failures-or-unresolved-evidence-conflict",
      ladder: Object.freeze(LEVELS.slice(RANK[level])),
      max: "max",
      returnToSolWhen: "scientific judgment changes hypothesis, claim, or research direction",
    }),
  });
}

export function escalateWorkflowEffort(current, {
  consecutiveSameClassFailures = 0,
  unresolvedEvidenceConflict = false,
} = {}) {
  const level = LEVELS.includes(current) ? current : "low";
  if (finite(consecutiveSameClassFailures) < 2 && !unresolvedEvidenceConflict) return level;
  return LEVELS[Math.min(LEVELS.length - 1, RANK[level] + 1)];
}
