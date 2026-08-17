function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function rng(seed = 0x51f15e) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function pairedAccuracy(rows, {
  localKey = "localCorrect",
  lunaKey = "lunaCorrect",
  bootstrapSamples = 20_000,
  confidence = 0.95,
  seed = 0x51f15e,
  nonInferiorityMargin = 0.10,
  equivalenceMargin = 0.02,
  minimumSampleForInference = 60,
} = {}) {
  if (!rows.length) throw new Error("Paired accuracy requires at least one row");
  const differences = rows.map((row) => Number(Boolean(row[localKey])) - Number(Boolean(row[lunaKey])));
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const random = rng(seed);
  const bootstrap = [];
  for (let sample = 0; sample < bootstrapSamples; sample += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(random() * differences.length)];
    }
    bootstrap.push(total / differences.length);
  }
  const alpha = (1 - confidence) / 2;
  const lower = quantile(bootstrap, alpha);
  const upper = quantile(bootstrap, 1 - alpha);
  const localAccuracy = rows.filter((row) => row[localKey]).length / rows.length;
  const lunaAccuracy = rows.filter((row) => row[lunaKey]).length / rows.length;
  const inferenceReady = rows.length >= minimumSampleForInference;
  return {
    n: rows.length,
    localAccuracy,
    lunaAccuracy,
    differenceLocalMinusLuna: mean,
    confidence,
    confidenceInterval: [lower, upper],
    minimumSampleForInference,
    inferenceReady,
    nonInferiorityMargin,
    localNonInferior: inferenceReady ? lower > -nonInferiorityMargin : null,
    equivalenceMargin,
    statisticallyEquivalent: inferenceReady ? lower >= -equivalenceMargin && upper <= equivalenceMargin : null,
    discordant: {
      localOnly: rows.filter((row) => row[localKey] && !row[lunaKey]).length,
      lunaOnly: rows.filter((row) => !row[localKey] && row[lunaKey]).length,
    },
  };
}

export function latencySummary(values) {
  return {
    n: values.length,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
  };
}

/** Strict lexicographic decision: correctness, then injected tokens, then
 * local assembly median/P95. Later criteria are inaccessible until accuracy
 * equivalence has been established. */
export function lexicographicDecision({ paired, local, luna }) {
  if (!paired.inferenceReady) return { winner: null, criterion: "accuracy-insufficient-sample" };
  const [lower, upper] = paired.confidenceInterval;
  if (lower > paired.equivalenceMargin) return { winner: "local", criterion: "accuracy" };
  if (upper < -paired.equivalenceMargin) return { winner: "luna", criterion: "accuracy" };
  if (!paired.statisticallyEquivalent) return { winner: null, criterion: "accuracy-inconclusive" };
  if (local.meanContextTokens !== luna.meanContextTokens) {
    return { winner: local.meanContextTokens < luna.meanContextTokens ? "local" : "luna", criterion: "context-tokens" };
  }
  if (local.assemblyMedianMs !== luna.assemblyMedianMs) {
    return { winner: local.assemblyMedianMs < luna.assemblyMedianMs ? "local" : "luna", criterion: "assembly-median" };
  }
  if (local.assemblyP95Ms !== luna.assemblyP95Ms) {
    return { winner: local.assemblyP95Ms < luna.assemblyP95Ms ? "local" : "luna", criterion: "assembly-p95" };
  }
  return { winner: "tie", criterion: "all-equal" };
}
