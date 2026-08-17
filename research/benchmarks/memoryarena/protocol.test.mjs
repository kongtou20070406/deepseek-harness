import assert from "node:assert/strict";
import test from "node:test";

import { adaptMemoryArenaRow } from "./adapter.mjs";
import {
  assertAgentVisibleFeedback,
  createTraceRecorder,
  normalizeCondition,
} from "./protocol.mjs";

const { onlineCase } = adaptMemoryArenaRow(
  {
    id: 1,
    questions: ["first search", "refine the prior result"],
    answers: ["first answer", "final answer"],
  },
  {
    config: "progressive_search",
    source: {
      sourceUri: "fixture://memoryarena",
      sourceFile: "fixture.jsonl",
      sourceSha256: "f".repeat(64),
      rawLineSha256: "a".repeat(64),
      rowNumber: 1,
      revision: "fixture",
    },
  },
);

test("trace records session, action, and feedback with ordered provenance", () => {
  const recorder = createTraceRecorder(onlineCase, {
    requested: "local",
    effective: "local",
  });
  const sessionId = onlineCase.sessions[0].sessionId;
  recorder.startSession(sessionId);
  recorder.recordAction(sessionId, { content: { command: "search" }, model: "fixture" });
  recorder.recordFeedback(sessionId, {
    observation: { state: "visible environment result" },
    reward: 0.5,
    done: false,
  });
  const trace = recorder.finish();

  assert.deepEqual(trace.events.map((event) => event.type), [
    "session.start",
    "agent.action",
    "environment.feedback",
  ]);
  assert.deepEqual(trace.events.map((event) => event.provenance.eventOrdinal), [1, 2, 3]);
  assert.equal(trace.events[1].provenance.stepOrdinal, 1);
  assert.equal(trace.events[2].provenance.stepOrdinal, 1);
  assert.equal(trace.events[2].provenance.sourceTimestamp, null);
  assert.match(trace.events[2].eventSha256, /^[0-9a-f]{64}$/);
});

test("Luna failure falls back immediately to local without waiting", () => {
  const condition = normalizeCondition({
    requested: "luna",
    effective: "local",
    fallbackReason: "index-not-ready",
    fallbackWaitMs: 0,
    lunaIndexReady: false,
  });
  assert.equal(condition.fellBack, true);
  assert.equal(condition.fallbackWaitMs, 0);
  assert.throws(
    () =>
      normalizeCondition({
        requested: "luna",
        effective: "local",
        fallbackReason: "index-not-ready",
        fallbackWaitMs: 1,
      }),
    /must not wait/,
  );
});

test("feedback rejects evaluator-only answer fields", () => {
  assert.equal(assertAgentVisibleFeedback({ state: "ordinary observation" }), true);
  assert.throws(
    () => assertAgentVisibleFeedback({ state: "visible", ground_truth: "secret" }),
    /not agent-visible/,
  );
});

test("recorder enforces action-feedback pairing", () => {
  const recorder = createTraceRecorder(onlineCase, {
    requested: "local",
    effective: "local",
  });
  const sessionId = onlineCase.sessions[0].sessionId;
  recorder.startSession(sessionId);
  recorder.recordAction(sessionId, { content: "first action" });
  assert.throws(() => recorder.finish(), /action without feedback/);
  assert.throws(
    () => recorder.recordAction(sessionId, { content: "second action" }),
    /awaiting feedback/,
  );
});
