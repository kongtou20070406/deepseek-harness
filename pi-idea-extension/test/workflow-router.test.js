import assert from "node:assert/strict";
import test from "node:test";
import { escalateWorkflowEffort, routeWorkflowEffort } from "../src/workflow-router.js";

test("short bounded mechanical work routes to Luna low", () => {
  const route = routeWorkflowEffort({ expectedMinutes: 4, stepCount: 2, mechanicallyDivisible: true });
  assert.equal(route.model, "gpt-5.6-luna");
  assert.equal(route.reasoningEffort, "low");
  assert.equal(route.chunk, null);
});

test("long divisible mechanical work is chunked and stays low", () => {
  const route = routeWorkflowEffort({
    expectedMinutes: 180,
    stepCount: 40,
    estimatedInputTokens: 160_000,
    mechanicallyDivisible: true,
    ambiguity: 0.1,
    risk: 0.1,
  });
  assert.equal(route.reasoningEffort, "low");
  assert.equal(route.chunk.recommended, true);
  assert.ok(route.chunk.chunks >= 9);
});

test("long strongly dependent task routes max even when it cannot be split", () => {
  const route = routeWorkflowEffort({
    expectedMinutes: 150,
    stepCount: 18,
    dependencyDepth: 6,
    ambiguity: 0.8,
    risk: 0.8,
    scientificJudgment: 0.55,
    estimatedInputTokens: 140_000,
    mechanicallyDivisible: false,
  });
  assert.equal(route.reasoningEffort, "max");
  assert.equal(route.chunk, null);
});

test("routing escalates only on repeated failure or an evidence conflict", () => {
  assert.equal(escalateWorkflowEffort("low", { consecutiveSameClassFailures: 1 }), "low");
  assert.equal(escalateWorkflowEffort("low", { consecutiveSameClassFailures: 2 }), "medium");
  assert.equal(escalateWorkflowEffort("high", { unresolvedEvidenceConflict: true }), "max");
  assert.equal(escalateWorkflowEffort("max", { consecutiveSameClassFailures: 9 }), "max");
});
