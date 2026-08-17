import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowTaskCard, validateWorkflowReturn } from "../src/workflow-task-card.js";

test("task card binds adaptive effort, ownership, acceptance, and hard limits", () => {
  const card = createWorkflowTaskCard({
    taskId: "task-fixed",
    projectId: "project-1",
    intentVersion: 3,
    intentHash: "sha256:intent",
    objective: "Inspect a long dependent experiment trace",
    inputRefs: ["e:trace", "file:report.json"],
    outputOwnership: ["artifact:trace-report"],
    acceptanceChecks: ["all-run-ids-accounted-for", "claims-have-evidence"],
    allowedOperations: ["read", "search"],
    forbiddenOperations: ["write", "gpu", "recursive-delegation"],
    limits: { maxMinutes: 120, maxInputTokens: 100_000, maxToolCalls: 30, maxRetries: 1 },
    strength: { stepCount: 14, dependencyDepth: 5, ambiguity: 0.7, risk: 0.6, scientificJudgment: 0.3 },
    createdAt: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(card.route.reasoningEffort, "max");
  assert.equal(card.limits.gpuAllowed, false);
  assert.equal(card.limits.concurrency, 1);
  assert.equal(card.recursiveDelegationAllowed, false);
  assert.match(card.cardHash, /^sha256:[0-9a-f]{64}$/);
});

test("a Workflow cannot claim complete without every deterministic acceptance check", () => {
  const card = createWorkflowTaskCard({
    objective: "List files",
    inputRefs: ["dir:src"],
    outputOwnership: ["artifact:file-list"],
    acceptanceChecks: ["all-files-listed"],
    limits: { maxMinutes: 5 },
    strength: { mechanicallyDivisible: true },
  });
  assert.throws(() => validateWorkflowReturn(card, {
    status: "complete",
    result: "done",
    evidence_refs: [],
    state_delta: {},
    artifacts: [],
    uncertainty_or_risk: null,
    acceptance: {},
  }), /acceptance check/i);
  assert.equal(validateWorkflowReturn(card, {
    status: "complete",
    result: "done",
    evidence_refs: ["e:list"],
    state_delta: {},
    artifacts: ["artifact:file-list"],
    uncertainty_or_risk: null,
    acceptance: { "all-files-listed": true },
  }), true);
});
