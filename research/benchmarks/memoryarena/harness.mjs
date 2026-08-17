import { createHash } from "node:crypto";

import { assertNoGoldLeak } from "./adapter.mjs";
import { comparePairedMemoryArenaRuns } from "./metrics.mjs";
import { createTraceRecorder, normalizeCondition } from "./protocol.mjs";

const OFFICIAL_CODE_URL = "https://github.com/ZexueHe/MemoryArena";

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assertOfficialAttestation(datasetManifest, evaluation) {
  if (!datasetManifest?.officialSnapshotVerified) {
    throw new Error("Official result requires a content-verified official MemoryArena dataset snapshot");
  }
  for (const [label, component] of [
    ["environment", evaluation.environment],
    ["evaluator", evaluation.evaluator],
  ]) {
    if (!component || component.sourceUrl !== OFFICIAL_CODE_URL) {
      throw new Error(`Official result requires the official MemoryArena ${label} source URL`);
    }
    if (
      typeof component.revision !== "string" ||
      !/^[0-9a-f]{7,64}$/i.test(component.revision.trim())
    ) {
      throw new Error(`Official result requires a pinned ${label} commit hash`);
    }
  }
}

function evaluationClass(datasetManifest, evaluation = {}) {
  const kind = evaluation.kind ?? "fixture";
  if (kind === "fixture") return "fixture";
  if (kind !== "official") throw new Error(`Unknown evaluation kind: ${kind}`);
  assertOfficialAttestation(datasetManifest, evaluation);
  return "official";
}

function assertTrace(trace, onlineCase, condition) {
  if (!trace || typeof trace !== "object" || !Array.isArray(trace.events)) {
    throw new TypeError("Executor must return a finalized provenance trace");
  }
  if (trace.caseKey !== onlineCase.caseKey) throw new Error("Trace caseKey mismatch");
  if (trace.condition.requested !== condition.requested || trace.condition.effective !== condition.effective) {
    throw new Error("Trace condition mismatch");
  }
  const requiredEventTypes = new Set(["session.start", "agent.action", "environment.feedback"]);
  for (const [index, event] of trace.events.entries()) {
    if (!requiredEventTypes.has(event.type)) {
      throw new Error(`Unknown trace event type at index ${index}: ${event.type}`);
    }
    const provenance = event.provenance;
    if (
      !provenance ||
      provenance.caseKey !== onlineCase.caseKey ||
      !Number.isInteger(provenance.sessionOrdinal) ||
      !Number.isInteger(provenance.eventOrdinal) ||
      !provenance.sourceUri ||
      !provenance.rowSha256
    ) {
      throw new Error(`Trace event ${index} is missing required provenance`);
    }
  }
}

async function executeOne({
  onlineCase,
  referenceCase,
  requestedCondition,
  executor,
  judge,
  comparability,
  resultClass,
}) {
  assertNoGoldLeak(onlineCase);
  let openedRecorder = false;
  const openTrace = (conditionInput) => {
    if (openedRecorder) throw new Error("Executor may open only one trace recorder per case");
    const normalized = normalizeCondition({ ...conditionInput, requested: requestedCondition });
    openedRecorder = true;
    return createTraceRecorder(onlineCase, normalized);
  };

  // The executor deliberately receives no referenceCase or evaluator callback.
  const execution = await executor({
    onlineCase,
    requestedCondition,
    openTrace,
  });
  if (!execution || typeof execution !== "object") {
    throw new TypeError("Executor must return an execution record");
  }
  const condition = normalizeCondition({
    ...(execution.condition ?? {}),
    requested: requestedCondition,
  });
  assertTrace(execution.trace, onlineCase, condition);

  // This is the only privileged boundary: the judge receives the private key
  // after the agent/environment execution has completed.
  const judgement = await judge({
    onlineCase,
    referenceCase,
    execution,
    condition,
  });
  if (!judgement || !Array.isArray(judgement.subtaskResults)) {
    throw new TypeError("Judge must return subtaskResults");
  }

  return {
    schemaVersion: 1,
    benchmark: "MemoryArena",
    caseKey: onlineCase.caseKey,
    config: onlineCase.config,
    condition,
    resultClass,
    subtaskResults: judgement.subtaskResults,
    taskSuccess: judgement.taskSuccess,
    tokenUsage: execution.tokenUsage ?? {},
    loopMetrics: execution.loopMetrics ?? [],
    traceSha256: sha256Json(execution.trace),
    outputSha256: sha256Json(execution.outputs ?? null),
    comparability,
  };
}

/**
 * Runs paired local/Luna conditions against the exact same frozen online
 * cases. It is sequential by default so model budget and environment state are
 * predictable. This adapter does not provide an official environment itself.
 */
export async function runPairedMemoryArenaProtocol({
  dataset,
  localExecutor,
  lunaExecutor,
  judge,
  comparability = {},
  evaluation = { kind: "fixture" },
} = {}) {
  if (!dataset?.manifest || !Array.isArray(dataset.onlineCases)) {
    throw new TypeError("dataset must be produced by the MemoryArena loader");
  }
  if (!(dataset.referencesByCaseKey instanceof Map)) {
    throw new TypeError("dataset.referencesByCaseKey must remain evaluator-private");
  }
  if (typeof localExecutor !== "function" || typeof lunaExecutor !== "function") {
    throw new TypeError("Both localExecutor and lunaExecutor are required");
  }
  if (typeof judge !== "function") throw new TypeError("judge is required");
  const resultClass = evaluationClass(dataset.manifest, evaluation);

  const localRuns = [];
  const lunaRuns = [];
  for (const onlineCase of dataset.onlineCases) {
    const referenceCase = dataset.referencesByCaseKey.get(onlineCase.caseKey);
    if (!referenceCase) throw new Error(`Missing private reference for ${onlineCase.caseKey}`);
    localRuns.push(
      await executeOne({
        onlineCase,
        referenceCase,
        requestedCondition: "local",
        executor: localExecutor,
        judge,
        comparability,
        resultClass,
      }),
    );
    lunaRuns.push(
      await executeOne({
        onlineCase,
        referenceCase,
        requestedCondition: "luna",
        executor: lunaExecutor,
        judge,
        comparability,
        resultClass,
      }),
    );
  }

  return {
    schemaVersion: 1,
    benchmark: "MemoryArena",
    resultClass,
    datasetManifest: dataset.manifest,
    evaluation,
    localRuns,
    lunaRuns,
    report: comparePairedMemoryArenaRuns(
      localRuns,
      lunaRuns,
      dataset.referencesByCaseKey,
    ),
  };
}
