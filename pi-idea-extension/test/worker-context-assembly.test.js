import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowTaskCard } from "../src/workflow-task-card.js";
import { assembleWorkerContext } from "../src/worker-context-assembly.js";

test("worker context inherits only frozen card and exact referenced evidence", () => {
  const card = createWorkflowTaskCard({
    taskId: "worker-1",
    objective: "Verify result E1",
    inputRefs: ["b1"],
    outputOwnership: ["report.json"],
    acceptanceChecks: ["evidence-opened"],
    limits: { maxInputTokens: 2_000 },
  });
  const result = assembleWorkerContext({
    taskCard: card,
    blocks: [
      { blockId: "b1", kind: "tool_result", rawHash: "sha256:1", raw: "E1 exact evidence" },
      { blockId: "b2", kind: "user_text", rawHash: "sha256:2", raw: "unrelated main chat" },
    ],
  });
  assert.equal(result.blocked, false);
  assert.match(result.content, /E1 exact evidence/);
  assert.doesNotMatch(result.content, /unrelated main chat/);
  assert.equal(result.manifest.inheritedMainConversation, false);
  assert.equal(result.manifest.summaryUsed, false);
});

test("worker context fails closed instead of truncating required evidence", () => {
  const card = createWorkflowTaskCard({
    taskId: "worker-2",
    objective: "Inspect exact evidence",
    inputRefs: ["call"],
    outputOwnership: ["result"],
    acceptanceChecks: ["checked"],
  });
  const result = assembleWorkerContext({ taskCard: card, blocks: [{ blockId: "call", kind: "tool_call", rawHash: "x", raw: "secret args" }] });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "forbidden-context-kind");
});
