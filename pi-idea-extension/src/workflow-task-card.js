import { createHash, randomUUID } from "node:crypto";
import { routeWorkflowEffort } from "./workflow-router.js";

const REQUIRED_RETURN_FIELDS = Object.freeze([
  "status",
  "result",
  "evidence_refs",
  "state_delta",
  "artifacts",
  "uncertainty_or_risk",
]);

function nonEmpty(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function stringList(value, name, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  if (!allowEmpty && !result.length) throw new Error(`${name} must not be empty`);
  return result;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

/** Create the immutable contract captured by a bounded Luna Workflow. */
export function createWorkflowTaskCard({
  objective,
  inputRefs,
  outputOwnership,
  dependencies = [],
  acceptanceChecks,
  allowedOperations = [],
  forbiddenOperations = [],
  limits = {},
  strength = {},
  intentVersion = null,
  intentHash = null,
  projectId = null,
  createdAt = new Date().toISOString(),
  taskId = randomUUID(),
} = {}) {
  const normalizedLimits = Object.freeze({
    maxMinutes: Math.max(1, Number(limits.maxMinutes) || 20),
    maxInputTokens: Math.max(1, Number(limits.maxInputTokens) || 24_000),
    maxOutputTokens: Math.max(1, Number(limits.maxOutputTokens) || 4_000),
    maxToolCalls: Math.max(0, Number(limits.maxToolCalls) || 0),
    maxRetries: Math.max(0, Math.min(2, Number(limits.maxRetries) || 0)),
    networkAllowed: Boolean(limits.networkAllowed),
    gpuAllowed: false,
    concurrency: 1,
  });
  const route = routeWorkflowEffort({
    expectedMinutes: normalizedLimits.maxMinutes,
    estimatedInputTokens: normalizedLimits.maxInputTokens,
    ...strength,
  });
  const card = {
    schema: 1,
    taskId: nonEmpty(taskId, "taskId"),
    projectId: projectId == null ? null : String(projectId),
    intentVersion,
    intentHash,
    objective: nonEmpty(objective, "objective"),
    inputRefs: stringList(inputRefs, "inputRefs", { allowEmpty: false }),
    outputOwnership: stringList(outputOwnership, "outputOwnership", { allowEmpty: false }),
    dependencies: stringList(dependencies, "dependencies"),
    acceptanceChecks: stringList(acceptanceChecks, "acceptanceChecks", { allowEmpty: false }),
    allowedOperations: stringList(allowedOperations, "allowedOperations"),
    forbiddenOperations: stringList(forbiddenOperations, "forbiddenOperations"),
    limits: normalizedLimits,
    route,
    returnContract: REQUIRED_RETURN_FIELDS,
    stopConditions: Object.freeze([
      "acceptance-checks-pass",
      "time-token-tool-or-retry-limit-reached",
      "required-authority-or-input-is-missing",
      "scientific-judgment-would-change-hypothesis-claim-or-direction",
      "operation-leaves-allowed-scope",
    ]),
    recursiveDelegationAllowed: false,
    createdAt,
  };
  return Object.freeze({ ...card, cardHash: `sha256:${sha256(stable(card))}` });
}

export function validateWorkflowReturn(card, value) {
  if (!card?.cardHash || card?.schema !== 1) throw new Error("A valid frozen task card is required");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow return must be an object");
  for (const field of REQUIRED_RETURN_FIELDS) {
    if (!Object.hasOwn(value, field)) throw new Error(`Workflow return is missing ${field}`);
  }
  const status = String(value.status || "");
  if (!["complete", "partial", "blocked", "failed"].includes(status)) throw new Error("Invalid Workflow status");
  if (!Array.isArray(value.evidence_refs) || !Array.isArray(value.artifacts)) {
    throw new Error("evidence_refs and artifacts must be arrays");
  }
  if (status === "complete" && !card.acceptanceChecks.every((check) => value.acceptance?.[check] === true)) {
    throw new Error("A complete Workflow must explicitly pass every acceptance check");
  }
  return true;
}
